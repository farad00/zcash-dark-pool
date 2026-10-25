// Disposable native process fixtures ONLY. Never imports application code or opens a database.
using System;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
public static class FocusedFixtureV1 {
    public static int Main(string[] args) {
        if(args.Length!=1) return 91;
        string mode=args[0];
        if(mode=="leaf-instant") return 0;
        if(mode=="incomplete-history") {
            for(int n=0;n<8;n++) {
                var start=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"leaf-instant");
                start.UseShellExecute=false; start.CreateNoWindow=true;
                using(var child=Process.Start(start))child.WaitForExit();
            }
            return 0;
        }
        if(mode=="leaf-short") { Thread.Sleep(600); return 0; }
        if(mode=="leaf-persistent" || mode=="sentinel") { Thread.Sleep(30000); return 0; }
        if(mode=="short-descendant" || mode=="persistent-descendant" || mode=="nonzero-descendant") {
            var start=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
                mode=="short-descendant" ? "leaf-short" : "leaf-persistent");
            start.UseShellExecute=false; start.CreateNoWindow=true;
            using(var child=Process.Start(start)) { Thread.Sleep(150); }
            return mode=="nonzero-descendant" ? 17 : 0;
        }
        if(mode=="interrupt" || mode=="supervisor-exit") { Thread.Sleep(30000); return 0; }
        if(mode=="success" || mode=="nonzero" || mode=="query-failure" || mode=="pid-mismatch" || mode=="utc-reversal") {
            Thread.Sleep(100); Console.WriteLine("offline process fixture"); return mode=="nonzero" ? 17 : 0;
        }
        return 92;
    }
}
