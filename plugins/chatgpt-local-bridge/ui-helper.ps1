param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public sealed class ClbOverlayForm : Form
{
    private int pointerX;
    private int pointerY;
    private bool pointerVisible;
    private readonly Pen borderPen = new Pen(Color.FromArgb(0, 120, 215), 6f);
    private readonly Pen pointerPen = new Pen(Color.FromArgb(0, 190, 255), 4f);
    private readonly SolidBrush pointerBrush = new SolidBrush(Color.FromArgb(220, 0, 120, 215));

    public ClbOverlayForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Bounds = SystemInformation.VirtualScreen;
        BackColor = Color.Fuchsia;
        TransparencyKey = Color.Fuchsia;
        DoubleBuffered = true;
        Opacity = 0.0;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_TRANSPARENT = 0x20;
            const int WS_EX_TOOLWINDOW = 0x80;
            const int WS_EX_LAYERED = 0x80000;
            const int WS_EX_NOACTIVATE = 0x08000000;
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    public void SetPointer(int screenX, int screenY, bool visible)
    {
        pointerX = screenX - Bounds.Left;
        pointerY = screenY - Bounds.Top;
        pointerVisible = visible;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = ClientRectangle;
        rect.Inflate(-3, -3);
        e.Graphics.DrawRectangle(borderPen, rect);
        if (pointerVisible)
        {
            const int r = 18;
            e.Graphics.DrawEllipse(pointerPen, pointerX - r, pointerY - r, r * 2, r * 2);
            e.Graphics.DrawLine(pointerPen, pointerX - 28, pointerY, pointerX + 28, pointerY);
            e.Graphics.DrawLine(pointerPen, pointerX, pointerY - 28, pointerX, pointerY + 28);
            Point[] tri = new Point[] {
                new Point(pointerX + 10, pointerY + 10),
                new Point(pointerX + 28, pointerY + 16),
                new Point(pointerX + 16, pointerY + 28)
            };
            e.Graphics.FillPolygon(pointerBrush, tri);
        }
    }
}

public static class ClbUi
{
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint INPUT_KEYBOARD = 1;

    static readonly object sync = new object();
    static Thread uiThread;
    static ClbOverlayForm overlay;
    static ManualResetEvent ready = new ManualResetEvent(false);


    public static bool FocusWindow(long hwnd)
    {
        IntPtr h = new IntPtr(hwnd);
        if (h == IntPtr.Zero) return false;
        ShowWindow(h, 9); // SW_RESTORE
        Thread.Sleep(80);
        return SetForegroundWindow(h);
    }

    public static void Start()
    {
        lock (sync)
        {
            if (uiThread != null) return;
            uiThread = new Thread(() => {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                overlay = new ClbOverlayForm();
                overlay.Shown += (s,e) => { overlay.Hide(); overlay.Opacity = 1.0; ready.Set(); };
                Application.Run(overlay);
            });
            uiThread.IsBackground = true;
            uiThread.SetApartmentState(ApartmentState.STA);
            uiThread.Start();
        }
        if (!ready.WaitOne(5000)) throw new Exception("Overlay startup timeout");
    }

    static void Invoke(Action a)
    {
        Start();
        if (overlay.InvokeRequired) overlay.Invoke(a); else a();
    }

    public static Rectangle VirtualScreen { get { return SystemInformation.VirtualScreen; } }
    public static Point CursorPoint { get { return Cursor.Position; } }

    public static void OverlayShow(int x, int y)
    {
        Invoke(() => {
            overlay.Bounds = SystemInformation.VirtualScreen;
            overlay.SetPointer(x, y, true);
            if (!overlay.Visible) overlay.Show();
            overlay.BringToFront();
            overlay.Invalidate();
        });
    }

    public static void OverlayUpdate(int x, int y)
    {
        Invoke(() => overlay.SetPointer(x, y, true));
    }

    public static void OverlayHide()
    {
        Invoke(() => { overlay.SetPointer(0, 0, false); overlay.Hide(); });
    }

    static Point Clamp(int x, int y)
    {
        Rectangle v = VirtualScreen;
        int cx = Math.Max(v.Left, Math.Min(v.Right - 1, x));
        int cy = Math.Max(v.Top, Math.Min(v.Bottom - 1, y));
        return new Point(cx, cy);
    }

    public static void SmoothMove(int x, int y, int durationMs)
    {
        Point start = Cursor.Position;
        Point end = Clamp(x, y);
        int duration = Math.Max(0, Math.Min(5000, durationMs));
        int steps = duration <= 0 ? 1 : Math.Max(2, Math.Min(180, duration / 8));
        OverlayShow(start.X, start.Y);
        for (int i = 1; i <= steps; i++)
        {
            double t = (double)i / steps;
            double eased = t * t * (3.0 - 2.0 * t);
            int nx = (int)Math.Round(start.X + (end.X - start.X) * eased);
            int ny = (int)Math.Round(start.Y + (end.Y - start.Y) * eased);
            SetCursorPos(nx, ny);
            OverlayUpdate(nx, ny);
            if (duration > 0) Thread.Sleep(Math.Max(1, duration / steps));
        }
        Thread.Sleep(80);
        OverlayHide();
    }

    static void ButtonFlags(string button, out uint down, out uint up)
    {
        string b = (button ?? "left").ToLowerInvariant();
        if (b == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; return; }
        if (b == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; return; }
        if (b != "left") throw new Exception("Unsupported mouse button");
        down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP;
    }

    public static void Click(int x, int y, string button, int clicks)
    {
        Point p = Clamp(x, y);
        SetCursorPos(p.X, p.Y);
        OverlayShow(p.X, p.Y);
        uint down, up; ButtonFlags(button, out down, out up);
        int count = Math.Max(1, Math.Min(3, clicks));
        Thread.Sleep(70);
        for (int i = 0; i < count; i++)
        {
            mouse_event(down, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(45);
            mouse_event(up, 0, 0, 0, UIntPtr.Zero);
            if (i + 1 < count) Thread.Sleep(90);
        }
        Thread.Sleep(130);
        OverlayHide();
    }

    public static void Drag(int[] xs, int[] ys, string button, int durationMs)
    {
        if (xs == null || ys == null || xs.Length != ys.Length || xs.Length < 2 || xs.Length > 2000) throw new Exception("Invalid drag path");
        Point first = Clamp(xs[0], ys[0]);
        SetCursorPos(first.X, first.Y);
        OverlayShow(first.X, first.Y);
        uint down, up; ButtonFlags(button, out down, out up);
        mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        int duration = Math.Max(50, Math.Min(30000, durationMs));
        int delay = Math.Max(1, duration / Math.Max(1, xs.Length - 1));
        try
        {
            for (int i = 1; i < xs.Length; i++)
            {
                Point p = Clamp(xs[i], ys[i]);
                SetCursorPos(p.X, p.Y);
                OverlayUpdate(p.X, p.Y);
                Thread.Sleep(delay);
            }
        }
        finally
        {
            mouse_event(up, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(120);
            OverlayHide();
        }
    }

    public static void Scroll(int x, int y, int delta)
    {
        Point p = Clamp(x, y);
        SetCursorPos(p.X, p.Y);
        OverlayShow(p.X, p.Y);
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, UIntPtr.Zero);
        Thread.Sleep(150);
        OverlayHide();
    }

    public static void TypeText(string text)
    {
        if (text == null) return;
        foreach (char ch in text)
        {
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].U.ki.wScan = ch;
            inputs[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].U.ki.wScan = ch;
            inputs[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new Exception("SendInput failed");
        }
    }

    static byte VkFor(string key)
    {
        string k = (key ?? "").Trim().ToUpperInvariant();
        if (k.Length == 1)
        {
            char c = k[0];
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (byte)c;
        }
        switch (k)
        {
            case "ENTER": return 0x0D; case "ESC": case "ESCAPE": return 0x1B; case "TAB": return 0x09;
            case "BACKSPACE": return 0x08; case "DELETE": return 0x2E; case "SPACE": return 0x20;
            case "LEFT": return 0x25; case "UP": return 0x26; case "RIGHT": return 0x27; case "DOWN": return 0x28;
            case "HOME": return 0x24; case "END": return 0x23; case "PAGEUP": return 0x21; case "PAGEDOWN": return 0x22;
        }
        if (k.StartsWith("F")) { int n; if (Int32.TryParse(k.Substring(1), out n) && n >= 1 && n <= 12) return (byte)(0x70 + n - 1); }
        throw new Exception("Unsupported key");
    }

    public static void KeyPress(string key, bool ctrl, bool shift, bool alt)
    {
        byte vk = VkFor(key);
        if (ctrl) keybd_event(0x11,0,0,UIntPtr.Zero);
        if (shift) keybd_event(0x10,0,0,UIntPtr.Zero);
        if (alt) keybd_event(0x12,0,0,UIntPtr.Zero);
        keybd_event(vk,0,0,UIntPtr.Zero);
        keybd_event(vk,0,KEYEVENTF_KEYUP,UIntPtr.Zero);
        if (alt) keybd_event(0x12,0,KEYEVENTF_KEYUP,UIntPtr.Zero);
        if (shift) keybd_event(0x10,0,KEYEVENTF_KEYUP,UIntPtr.Zero);
        if (ctrl) keybd_event(0x11,0,KEYEVENTF_KEYUP,UIntPtr.Zero);
    }

    static ImageCodecInfo JpegCodec()
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") return c;
        throw new Exception("JPEG codec unavailable");
    }

    static byte[] EncodeJpeg(Bitmap bmp, long quality)
    {
        using (var ms = new MemoryStream())
        using (var ep = new EncoderParameters(1))
        {
            ep.Param[0] = new EncoderParameter(Encoder.Quality, quality);
            bmp.Save(ms, JpegCodec(), ep);
            return ms.ToArray();
        }
    }

    public static string CaptureBase64(int maxWidth, out int imageWidth, out int imageHeight, out int vx, out int vy, out int vw, out int vh, out int bytes)
    {
        Rectangle v = VirtualScreen;
        vx = v.Left; vy = v.Top; vw = v.Width; vh = v.Height;
        using (var src = new Bitmap(v.Width, v.Height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(src)) g.CopyFromScreen(v.Left, v.Top, 0, 0, v.Size, CopyPixelOperation.SourceCopy);
            int targetW = Math.Max(320, Math.Min(Math.Max(320, maxWidth), v.Width));
            int targetH = (int)Math.Round(v.Height * (targetW / (double)v.Width));
            using (var dst = new Bitmap(targetW, targetH, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(dst))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(src, 0, 0, targetW, targetH);
                }
                byte[] data = null;
                long[] qualities = new long[] { 48L, 38L, 28L, 20L };
                foreach (long q in qualities)
                {
                    data = EncodeJpeg(dst, q);
                    if (data.Length <= 380000) break;
                }
                if (data.Length > 520000) throw new Exception("Screenshot remains too large");
                imageWidth = targetW; imageHeight = targetH; bytes = data.Length;
                return Convert.ToBase64String(data);
            }
        }
    }


    static Rectangle ClampRectToVirtual(int x, int y, int width, int height)
    {
        Rectangle v = VirtualScreen;
        Rectangle r = Rectangle.Intersect(v, new Rectangle(x, y, Math.Max(1, width), Math.Max(1, height)));
        if (r.Width < 1 || r.Height < 1) throw new Exception("Capture region is outside the virtual screen");
        return r;
    }

    static string CaptureRectBase64(Rectangle r, int maxWidth, out int imageWidth, out int imageHeight, out int bytes)
    {
        using (var src = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(src)) g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
            int targetW = Math.Max(1, Math.Min(Math.Max(1, maxWidth), r.Width));
            int targetH = Math.Max(1, (int)Math.Round(r.Height * (targetW / (double)r.Width)));
            using (var dst = new Bitmap(targetW, targetH, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(dst))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(src, 0, 0, targetW, targetH);
                }
                byte[] data = null;
                foreach (long q in new long[] { 55L, 42L, 32L, 24L, 18L })
                {
                    data = EncodeJpeg(dst, q);
                    if (data.Length <= 380000) break;
                }
                if (data.Length > 520000) throw new Exception("Region screenshot remains too large");
                imageWidth = targetW; imageHeight = targetH; bytes = data.Length;
                return Convert.ToBase64String(data);
            }
        }
    }

    public static string CaptureRegionBase64(int x, int y, int width, int height, int maxWidth, out int imageWidth, out int imageHeight, out int rx, out int ry, out int rw, out int rh, out int bytes)
    {
        Rectangle r = ClampRectToVirtual(x, y, width, height);
        rx = r.Left; ry = r.Top; rw = r.Width; rh = r.Height;
        return CaptureRectBase64(r, maxWidth, out imageWidth, out imageHeight, out bytes);
    }

    static Bitmap DecodeBitmap(string base64, int width, int height)
    {
        byte[] data = Convert.FromBase64String(base64 ?? "");
        using (var ms = new MemoryStream(data))
        using (var img = Image.FromStream(ms, true, true))
        {
            int w = width > 0 ? width : img.Width;
            int h = height > 0 ? height : img.Height;
            if (w < 1 || h < 1 || w > 4096 || h > 4096) throw new Exception("Invalid image dimensions");
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.White);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(img, 0, 0, w, h);
            }
            return bmp;
        }
    }

    public static void SetClipboardImageBase64(string base64, int width, int height, out int imageWidth, out int imageHeight)
    {
        Bitmap bmp = DecodeBitmap(base64, width, height);
        imageWidth = bmp.Width; imageHeight = bmp.Height;
        Exception err = null;
        Invoke(() => {
            try { Clipboard.SetDataObject(new Bitmap(bmp), true); }
            catch (Exception ex) { err = ex; }
        });
        bmp.Dispose();
        if (err != null) throw err;
    }

    public static void PasteImageBase64(string base64, int width, int height, out int imageWidth, out int imageHeight)
    {
        SetClipboardImageBase64(base64, width, height, out imageWidth, out imageHeight);
        Point p = Cursor.Position;
        OverlayShow(p.X, p.Y);
        try
        {
            Thread.Sleep(180);
            KeyPress("V", true, false, false);
            Thread.Sleep(500);
        }
        finally { OverlayHide(); }
    }

    public static Rectangle FindLargestBrightRegion(out double confidence, out int foregroundX, out int foregroundY, out int foregroundWidth, out int foregroundHeight)
    {
        Rectangle v = VirtualScreen;
        Rectangle scope = v;
        IntPtr hwnd = GetForegroundWindow();
        RECT wr;
        if (hwnd != IntPtr.Zero && GetWindowRect(hwnd, out wr))
        {
            Rectangle fr = Rectangle.Intersect(v, Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom));
            if (fr.Width >= 200 && fr.Height >= 160) scope = fr;
        }
        foregroundX = scope.Left; foregroundY = scope.Top; foregroundWidth = scope.Width; foregroundHeight = scope.Height;
        using (var bmp = new Bitmap(scope.Width, scope.Height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(scope.Left, scope.Top, 0, 0, scope.Size, CopyPixelOperation.SourceCopy);
            int step = Math.Max(3, Math.Min(8, Math.Max(scope.Width, scope.Height) / 360));
            int gw = (scope.Width + step - 1) / step;
            int gh = (scope.Height + step - 1) / step;
            bool[] bright = new bool[gw * gh];
            for (int gy = 0; gy < gh; gy++) for (int gx = 0; gx < gw; gx++)
            {
                int px = Math.Min(scope.Width - 1, gx * step);
                int py = Math.Min(scope.Height - 1, gy * step);
                Color c = bmp.GetPixel(px, py);
                bright[gy * gw + gx] = c.R >= 242 && c.G >= 242 && c.B >= 242 && Math.Max(c.R, Math.Max(c.G,c.B)) - Math.Min(c.R, Math.Min(c.G,c.B)) <= 12;
            }
            bool[] seen = new bool[bright.Length];
            int bestCount=0,bx0=0,by0=0,bx1=0,by1=0;
            int[] qx = new int[bright.Length]; int[] qy = new int[bright.Length];
            for (int sy=0; sy<gh; sy++) for (int sx=0; sx<gw; sx++)
            {
                int si=sy*gw+sx; if(!bright[si] || seen[si]) continue;
                int head=0,tail=0,count=0,minx=sx,maxx=sx,miny=sy,maxy=sy;
                seen[si]=true; qx[tail]=sx; qy[tail]=sy; tail++;
                while(head<tail)
                {
                    int cx=qx[head], cy=qy[head]; head++; count++;
                    if(cx<minx)minx=cx;if(cx>maxx)maxx=cx;if(cy<miny)miny=cy;if(cy>maxy)maxy=cy;
                    int[,] d = new int[,]{{1,0},{-1,0},{0,1},{0,-1}};
                    for(int k=0;k<4;k++){int nx=cx+d[k,0],ny=cy+d[k,1];if(nx<0||ny<0||nx>=gw||ny>=gh)continue;int ni=ny*gw+nx;if(bright[ni]&&!seen[ni]){seen[ni]=true;qx[tail]=nx;qy[tail]=ny;tail++;}}
                }
                if(count>bestCount){bestCount=count;bx0=minx;by0=miny;bx1=maxx;by1=maxy;}
            }
            if(bestCount < 100) throw new Exception("No large bright region detected");
            int left = scope.Left + bx0*step;
            int top = scope.Top + by0*step;
            int right = Math.Min(scope.Right, scope.Left + (bx1+1)*step);
            int bottom = Math.Min(scope.Bottom, scope.Top + (by1+1)*step);
            Rectangle result = Rectangle.FromLTRB(left,top,right,bottom);
            confidence = Math.Min(1.0, bestCount / (double)Math.Max(1, gw*gh));
            return result;
        }
    }

    public static void CompareImageRegion(string base64, int x, int y, int width, int height, out double mae, out double rmse, out double matchScore, out int samples)
    {
        Rectangle r = ClampRectToVirtual(x,y,width,height);
        using (var target = DecodeBitmap(base64, r.Width, r.Height))
        using (var actual = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(actual)) g.CopyFromScreen(r.Left,r.Top,0,0,r.Size,CopyPixelOperation.SourceCopy);
            double abs=0.0,sq=0.0; int n=0;
            int step = Math.Max(1, Math.Min(4, Math.Max(r.Width,r.Height)/700));
            for(int yy=0;yy<r.Height;yy+=step) for(int xx=0;xx<r.Width;xx+=step)
            {
                Color a=actual.GetPixel(xx,yy), b=target.GetPixel(xx,yy);
                int dr=a.R-b.R,dg=a.G-b.G,db=a.B-b.B;
                abs += Math.Abs(dr)+Math.Abs(dg)+Math.Abs(db);
                sq += dr*dr+dg*dg+db*db;
                n += 3;
            }
            samples=n; mae=n>0?abs/n:255.0; rmse=n>0?Math.Sqrt(sq/n):255.0; matchScore=Math.Max(0.0,Math.Min(1.0,1.0-mae/255.0));
        }
    }

    public static Color SamplePixel(int x, int y)
    {
        Point p = Clamp(x,y);
        using(var bmp=new Bitmap(1,1,PixelFormat.Format24bppRgb))
        {
            using(var g=Graphics.FromImage(bmp)) g.CopyFromScreen(p.X,p.Y,0,0,new Size(1,1),CopyPixelOperation.SourceCopy);
            return bmp.GetPixel(0,0);
        }
    }

    public static int RenderLineArtBase64(string base64, int x, int y, int width, int height, int threshold, int sampleStep, int maxRuns)
    {
        int step=Math.Max(1,Math.Min(16,sampleStep));
        int sw=Math.Max(1,width/step), sh=Math.Max(1,height/step);
        int runs=0;
        using(var target=DecodeBitmap(base64,sw,sh))
        {
            Point p0=Clamp(x,y); OverlayShow(p0.X,p0.Y);
            try
            {
                for(int yy=0;yy<sh;yy++)
                {
                    int xx=0;
                    while(xx<sw)
                    {
                        Color c=target.GetPixel(xx,yy); int lum=(c.R*299+c.G*587+c.B*114)/1000;
                        if(lum>=threshold){xx++;continue;}
                        int start=xx; while(xx+1<sw){Color n=target.GetPixel(xx+1,yy);int l=(n.R*299+n.G*587+n.B*114)/1000;if(l>=threshold)break;xx++;}
                        int end=xx;
                        int sy=y+yy*step, sx1=x+start*step, sx2=x+Math.Min(width-1,(end+1)*step-1);
                        Point a=Clamp(sx1,sy), b=Clamp(sx2,sy);
                        SetCursorPos(a.X,a.Y); OverlayUpdate(a.X,a.Y);
                        mouse_event(MOUSEEVENTF_LEFTDOWN,0,0,0,UIntPtr.Zero);
                        if(a.X!=b.X){SetCursorPos(b.X,b.Y);OverlayUpdate(b.X,b.Y);}
                        mouse_event(MOUSEEVENTF_LEFTUP,0,0,0,UIntPtr.Zero);
                        runs++; if(runs>=maxRuns) return runs;
                        xx++;
                    }
                }
                return runs;
            }
            finally { Thread.Sleep(100); OverlayHide(); }
        }
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Windows.Forms','System.Drawing'
[ClbUi]::Start()

function Send-Reply([object]$obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 12))
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = ''
  try {
    $cmd = $line | ConvertFrom-Json
    $id = [string]$cmd.id
    switch ([string]$cmd.action) {
      'ping' {
        Send-Reply @{ id=$id; ok=$true; data=@{ pong=$true } }
      }
      'screen-info' {
        $v=[ClbUi]::VirtualScreen; $p=[ClbUi]::CursorPoint
        Send-Reply @{ id=$id; ok=$true; data=@{ virtualX=$v.X; virtualY=$v.Y; virtualWidth=$v.Width; virtualHeight=$v.Height; cursorX=$p.X; cursorY=$p.Y } }
      }
      'focus-window' {
        $ok=[ClbUi]::FocusWindow([long]$cmd.hwnd)
        Send-Reply @{ id=$id; ok=$true; data=@{ hwnd=[long]$cmd.hwnd; focused=[bool]$ok } }
      }
      'screen-capture' {
        $iw=0; $ih=0; $vx=0; $vy=0; $vw=0; $vh=0; $bytes=0
        $maxWidth = if($cmd.maxWidth){ [int]$cmd.maxWidth } else { 1280 }
        $b64=[ClbUi]::CaptureBase64($maxWidth,[ref]$iw,[ref]$ih,[ref]$vx,[ref]$vy,[ref]$vw,[ref]$vh,[ref]$bytes)
        Send-Reply @{ id=$id; ok=$true; data=@{ mime='image/jpeg'; base64=$b64; imageWidth=$iw; imageHeight=$ih; virtualX=$vx; virtualY=$vy; virtualWidth=$vw; virtualHeight=$vh; bytes=$bytes } }
      }

      'screen-capture-region' {
        $iw=0; $ih=0; $rx=0; $ry=0; $rw=0; $rh=0; $bytes=0
        $maxWidth = if($cmd.maxWidth){ [int]$cmd.maxWidth } else { [int]$cmd.width }
        $b64=[ClbUi]::CaptureRegionBase64([int]$cmd.x,[int]$cmd.y,[int]$cmd.width,[int]$cmd.height,$maxWidth,[ref]$iw,[ref]$ih,[ref]$rx,[ref]$ry,[ref]$rw,[ref]$rh,[ref]$bytes)
        Send-Reply @{ id=$id; ok=$true; data=@{ mime='image/jpeg'; base64=$b64; imageWidth=$iw; imageHeight=$ih; x=$rx; y=$ry; width=$rw; height=$rh; bytes=$bytes } }
      }
      'find-bright-region' {
        $conf=0.0;$fx=0;$fy=0;$fw=0;$fh=0
        $r=[ClbUi]::FindLargestBrightRegion([ref]$conf,[ref]$fx,[ref]$fy,[ref]$fw,[ref]$fh)
        Send-Reply @{ id=$id; ok=$true; data=@{ x=$r.X; y=$r.Y; width=$r.Width; height=$r.Height; confidence=$conf; foregroundX=$fx; foregroundY=$fy; foregroundWidth=$fw; foregroundHeight=$fh } }
      }
      'sample-pixel' {
        $c=[ClbUi]::SamplePixel([int]$cmd.x,[int]$cmd.y)
        $hex=('#{0:X2}{1:X2}{2:X2}' -f $c.R,$c.G,$c.B)
        Send-Reply @{ id=$id; ok=$true; data=@{ x=[int]$cmd.x; y=[int]$cmd.y; r=[int]$c.R; g=[int]$c.G; b=[int]$c.B; hex=$hex } }
      }
      'clipboard-set-image' {
        $iw=0;$ih=0;[ClbUi]::SetClipboardImageBase64([string]$cmd.base64,[int]$cmd.width,[int]$cmd.height,[ref]$iw,[ref]$ih)
        Send-Reply @{ id=$id; ok=$true; data=@{ imageWidth=$iw; imageHeight=$ih } }
      }
      'paint-render-image' {
        $iw=0;$ih=0;[ClbUi]::PasteImageBase64([string]$cmd.base64,[int]$cmd.width,[int]$cmd.height,[ref]$iw,[ref]$ih)
        Send-Reply @{ id=$id; ok=$true; data=@{ imageWidth=$iw; imageHeight=$ih; pasted=$true } }
      }
      'compare-image-region' {
        $mae=0.0;$rmse=0.0;$score=0.0;$samples=0
        [ClbUi]::CompareImageRegion([string]$cmd.base64,[int]$cmd.x,[int]$cmd.y,[int]$cmd.width,[int]$cmd.height,[ref]$mae,[ref]$rmse,[ref]$score,[ref]$samples)
        Send-Reply @{ id=$id; ok=$true; data=@{ mae=$mae; rmse=$rmse; matchScore=$score; samples=$samples } }
      }
      'mouse-render-line-art' {
        $runs=[ClbUi]::RenderLineArtBase64([string]$cmd.base64,[int]$cmd.x,[int]$cmd.y,[int]$cmd.width,[int]$cmd.height,[int]$cmd.threshold,[int]$cmd.sampleStep,[int]$cmd.maxRuns)
        Send-Reply @{ id=$id; ok=$true; data=@{ runs=$runs; x=[int]$cmd.x; y=[int]$cmd.y; width=[int]$cmd.width; height=[int]$cmd.height } }
      }
      'mouse-move' {
        $duration = 350; if($null -ne $cmd.durationMs){ $duration=[int]$cmd.durationMs }; [ClbUi]::SmoothMove([int]$cmd.x,[int]$cmd.y,$duration)
        $p=[ClbUi]::CursorPoint; Send-Reply @{ id=$id; ok=$true; data=@{ x=$p.X; y=$p.Y } }
      }
      'mouse-click' {
        $clicks=1; if($cmd.clicks){$clicks=[int]$cmd.clicks}; [ClbUi]::Click([int]$cmd.x,[int]$cmd.y,[string]$cmd.button,$clicks)
        Send-Reply @{ id=$id; ok=$true; data=@{ x=[int]$cmd.x; y=[int]$cmd.y; button=([string]$cmd.button); clicks=$clicks } }
      }
      'mouse-drag' {
        if($null -eq $cmd.points -or $cmd.points.Count -lt 2){ throw 'mouse-drag requires at least two points' }
        [int[]]$xs=@($cmd.points | ForEach-Object {[int]$_.x})
        [int[]]$ys=@($cmd.points | ForEach-Object {[int]$_.y})
        $duration=[Math]::Max(120,$cmd.points.Count*12); if($cmd.durationMs){$duration=[int]$cmd.durationMs}; [ClbUi]::Drag($xs,$ys,[string]$cmd.button,$duration)
        $p=[ClbUi]::CursorPoint; Send-Reply @{ id=$id; ok=$true; data=@{ x=$p.X; y=$p.Y; points=$cmd.points.Count } }
      }
      'mouse-scroll' {
        [ClbUi]::Scroll([int]$cmd.x,[int]$cmd.y,[int]$cmd.delta)
        Send-Reply @{ id=$id; ok=$true; data=@{ x=[int]$cmd.x; y=[int]$cmd.y; delta=[int]$cmd.delta } }
      }
      'type-text' {
        [ClbUi]::TypeText([string]$cmd.text)
        Send-Reply @{ id=$id; ok=$true; data=@{ chars=([string]$cmd.text).Length } }
      }
      'key-press' {
        [ClbUi]::KeyPress([string]$cmd.key,[bool]$cmd.ctrl,[bool]$cmd.shift,[bool]$cmd.alt)
        Send-Reply @{ id=$id; ok=$true; data=@{ key=[string]$cmd.key; ctrl=[bool]$cmd.ctrl; shift=[bool]$cmd.shift; alt=[bool]$cmd.alt } }
      }
      default { throw ('Unsupported UI helper action: ' + [string]$cmd.action) }
    }
  } catch {
    Send-Reply @{ id=$id; ok=$false; error=$_.Exception.Message }
  }
}
