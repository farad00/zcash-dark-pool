// Dedicated focused-v1 native barrier. No general command-line entry point.
// RunStage accepts only the byte-pinned manifest and one of its stage identities.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class FocusedNativeV1
{
    public const string ManifestHash = "5e01a728d362c098303e63b27c7d578112a51a5986284e564d67ec0e049f3986";
    // Lifecycle budgets only, starting AFTER root exit / failure. No application deadline.
    public const int DrainMilliseconds = 2000, CleanupMilliseconds = 5000;
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct Completion { public IntPtr Key, Port; }
    [StructLayout(LayoutKind.Sequential)] struct AttributeTag { public uint Attributes, Tag; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr file, int kind, out AttributeTag info, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Completion info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ExtendedLimit info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long value);
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long value);
    [DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr first, IntPtr second);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, IntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out IntPtr key, out IntPtr pid, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr psa, IntPtr tsa, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security, uint disposition, uint flags, IntPtr template);

    public sealed class Identity {
        public uint pid; public string creation_filetime, creation_utc, handle_binding, observed_utc, exit_utc, binding_id;
        public bool membership_verified, handle_closed; public int? exit_code;
        internal IntPtr handle;
        internal long creation;
        internal bool reaped;
    }
    public sealed class Query {
        public string observed_utc, purpose, event_sequence; public bool succeeded; public uint? active_processes, total_processes; public int? win32_error;
    }
    public sealed class Trace {
        public int version = 3; public string evidence_class, started_utc, ended_utc, first_failure;
        public Ordering ordering;
        internal bool reverseAudit; internal int nextBinding;
        public string root_creation_filetime;
        public bool tree_completion_verified;
        public Launch launch;
        public Containment containment = new Containment();
        public List<AcquisitionFailure> acquisition_failures = new List<AcquisitionFailure>();
        public int acquisition_failures_unretained;
        internal HashSet<uint> fixtureOmissions = new HashSet<uint>();
        internal int omitLimit;
        public uint root_pid; public int? root_exit_code; public string root_exit_utc;
        public bool assigned_before_resume, root_exit_observed, zero_observed, cleanup_succeeded, termination_requested;
        public bool identity_inventory_complete; public uint? total_processes;
        public int drain_milliseconds = DrainMilliseconds, cleanup_milliseconds = CleanupMilliseconds;
        public List<Identity> processes = new List<Identity>(); public List<Query> accounting = new List<Query>();
        public string[] command; public Dictionary<string,object> ownership;
        public uint? supervisor_pid; public string supervisor_creation_filetime;
    }
    public sealed class Input { public string path, sha256; }
    public sealed class Launch { public string executable_path, image_path, executable_sha256, command_line, policy; public string[] arguments; public Input[] inputs; }
    public sealed class Containment { public bool assigned_before_resume, membership_verified, same_job_handle, non_inheritable; public uint job_flags; public string job_handle_binding; }
    public sealed class AcquisitionFailure { public uint pid; public int win32_error; public string code, observed_utc; }
    public sealed class JournalEvent {
        public string sequence, kind, subject, qpc_begin, qpc_end, utc, session_id;
        public uint thread_id;
        public object details;
    }
    public sealed class Ordering {
        public string clock="QueryPerformanceCounter", frequency, session_id, observer_creation_filetime, stage_id;
        public uint observer_pid, thread_id;
        public uint supervisor_pid; public string supervisor_creation_filetime;
        public int capacity=32768, record_count;
        public bool complete, overflow;
        public List<JournalEvent> events=new List<JournalEvent>();
    }
    static long Begin(Trace t) {
        if(t.ordering==null || GetCurrentThreadId()!=t.ordering.thread_id)throw new InvalidOperationException("OBSERVER_THREAD_CHANGED");
        if(t.ordering.events.Count>=t.ordering.capacity){t.ordering.overflow=true;throw new InvalidOperationException("JOURNAL_OVERFLOW");}
        long tick; if(!QueryPerformanceCounter(out tick))throw new InvalidOperationException("QPC_FAILED");
        if(t.ordering.events.Count>0 && tick<long.Parse(t.ordering.events.Last().qpc_end))throw new InvalidOperationException("QPC_REVERSED");
        return tick;
    }
    static string Record(Trace t,string kind,string subject,long begin,object details) {
        if(GetCurrentThreadId()!=t.ordering.thread_id)throw new InvalidOperationException("OBSERVER_THREAD_CHANGED");
        long end; if(!QueryPerformanceCounter(out end) || end<begin)throw new InvalidOperationException("QPC_FAILED_OR_REVERSED");
        if(t.ordering.events.Count>=t.ordering.capacity){t.ordering.overflow=true;throw new InvalidOperationException("JOURNAL_OVERFLOW");}
        string seq=(t.ordering.events.Count+1).ToString();
        t.ordering.events.Add(new JournalEvent{sequence=seq,kind=kind,subject=subject,qpc_begin=begin.ToString(),qpc_end=end.ToString(),utc=Now(),details=details,thread_id=GetCurrentThreadId(),session_id=t.ordering.session_id});
        t.ordering.record_count=t.ordering.events.Count;return seq;
    }
    static string Handle(IntPtr h){return "0x"+h.ToInt64().ToString("x");}
    static void Release(Trace t,Identity p){long b=Begin(t);Close(ref p.handle);p.handle_closed=true;Record(t,"release",p.binding_id,b,new {closed=true});}
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    // Output includes the bounded QPC journal twice in the full trace. The default
    // AJAX serializer limit (2 Mi characters) is too small for real stage evidence.
    // Keep an explicit finite output budget; input/manifest parsing is unchanged.
    static readonly JavaScriptSerializer EvidenceJson = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    static string Now() { return DateTime.UtcNow.ToString("o"); }
    static string Utc(long time) { return DateTime.FromFileTimeUtc(time).ToString("o"); }
    static void Check(bool value, string code) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), code); }
    static bool Valid(IntPtr h) { return h != IntPtr.Zero && h != new IntPtr(-1); }
    static void Close(ref IntPtr h) { if (Valid(h)) { Check(CloseHandle(h), "CLOSE_HANDLE"); h = IntPtr.Zero; } }
    static string Hash(byte[] data) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(data)).Replace("-", "").ToLowerInvariant(); }
    static void Write(string path, object value) {
        // A serialization failure must not leave an empty success-artifact placeholder.
        var bytes = new UTF8Encoding(false).GetBytes(EvidenceJson.Serialize(value));
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
            file.Write(bytes, 0, bytes.Length); file.Flush(true);
        }
    }
    static string Quote(string value) {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("INVALID_ARGUMENT");
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') b.Append('\\', slashes * 2 + 1).Append('"'); else b.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return b.Append('\\', slashes * 2).Append('"').ToString();
    }
    // Check every ancestor, not just the final component. No redirected artifact/tool paths.
    static string Ordinary(string path, bool directory) {
        path = Path.GetFullPath(path);
        for (string p = path; !String.IsNullOrEmpty(p); p = Path.GetDirectoryName(p)) {
            if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) == 0) continue;
            var sa=new Security { Length=Marshal.SizeOf(typeof(Security)) };
            IntPtr h=CreateFileW(p,0,7,ref sa,3,0x02200000,IntPtr.Zero);
            try {
                Check(Valid(h),"PATH_TAG_HANDLE"); AttributeTag tag;
                Check(GetFileInformationByHandleEx(h,9,out tag,(uint)Marshal.SizeOf(typeof(AttributeTag))),"PATH_TAG_QUERY");
                // OneDrive CLOUD/CLOUD_1..F tags do not redirect names. No name-surrogate tags allowed.
                if ((tag.Tag & 0xffff0fffU) != 0x9000001aU) throw new InvalidOperationException("REDIRECTED_PATH");
            } finally { Close(ref h); }
        }
        if (directory ? !Directory.Exists(path) : !File.Exists(path)) throw new InvalidOperationException("MISSING_PATH");
        return path;
    }
    static void OutputDirectory(string repo, string directory) {
        repo = Ordinary(repo, true); directory = Ordinary(directory, true);
        string prefix = Path.Combine(repo, ".tools", "phase9-focused") + Path.DirectorySeparatorChar;
        if (!directory.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || Directory.GetFileSystemEntries(directory).Length != 0)
            throw new InvalidOperationException("FRESH_OUTPUT_REQUIRED");
    }
    static Identity Bind(IntPtr handle, uint pid, IntPtr job, long? expected, Trace trace) {
        long begin=Begin(trace);
        long created, exited, kernel, user; bool member;
        Check(GetProcessId(handle) == pid, "HANDLE_PID_MISMATCH");
        Check(GetProcessTimes(handle, out created, out exited, out kernel, out user), "PROCESS_TIMES");
        if (expected.HasValue && created != expected.Value) throw new InvalidOperationException("CREATION_TIME_MISMATCH");
        Check(IsProcessInJob(handle, job, out member), "JOB_MEMBERSHIP_QUERY");
        if (!member) throw new InvalidOperationException("NOT_OWNED");
        var identity=new Identity { pid=pid, creation=created, creation_filetime=created.ToString(), creation_utc=Utc(created),
            handle_binding="GetProcessId+GetProcessTimes+IsProcessInJob:0x"+handle.ToInt64().ToString("x"),
            observed_utc=trace.reverseAudit ? DateTime.UtcNow.AddHours(-1).ToString("o") : Now(), membership_verified=true, handle=handle,
            binding_id="process-"+(++trace.nextBinding).ToString() };
        Record(trace,"bind",identity.binding_id,begin,new {pid=identity.pid,creation_filetime=identity.creation_filetime,creation_utc=identity.creation_utc,handle_binding=identity.handle_binding,observed_utc=identity.observed_utc,membership_verified=true});
        return identity;
    }
    static void AcquisitionError(Trace trace, uint pid, int error, string code) {
        if(trace.acquisition_failures.Count < 512) trace.acquisition_failures.Add(new AcquisitionFailure {pid=pid,win32_error=error,code=code,observed_utc=Now()});
        else trace.acquisition_failures_unretained++;
    }
    static void Observe(IntPtr job, uint pid, Trace trace) {
        // Finite offline fault only: deliberately omit identities, never alter native accounting.
        if(trace.fixtureOmissions.Contains(pid)) return;
        if(trace.omitLimit > 0 && pid != trace.root_pid) {
            trace.omitLimit--; trace.fixtureOmissions.Add(pid); AcquisitionError(trace,pid,0,"OFFLINE_IDENTITY_NOT_ACQUIRED"); return;
        }
        IntPtr h = OpenProcess(0x100000 | 0x1000, false, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        if (!Valid(h)) { AcquisitionError(trace,pid,Marshal.GetLastWin32Error(),"OPEN_PROCESS_FAILED"); return; }
        try {
            // Compare live native objects before deduplication; never merge by PID/time text.
            if(trace.processes.Any(p=>!p.handle_closed && CompareObjectHandles(h,p.handle)))return;
            var identity = Bind(h, pid, job, null, trace);
            if (trace.processes.Any(p => p.pid == pid && p.creation_filetime == identity.creation_filetime))throw new InvalidOperationException("AMBIGUOUS_REACQUISITION");
            trace.processes.Add(identity); h = IntPtr.Zero;
        }
        finally { Close(ref h); }
    }
    static void Discover(IntPtr job, IntPtr port, Trace trace) {
        uint message; IntPtr key, pid;
        // Notifications are hints, NOT authoritative accounting or identity evidence.
        for (int n=0; n<4096 && GetQueuedCompletionStatus(port, out message, out key, out pid, 0); n++)
            if (message == 6 && key == new IntPtr(1) && pid.ToInt64() > 0) Observe(job, checked((uint)pid.ToInt64()), trace);
        int capacity = 1024;
        while (true) {
            IntPtr list = Marshal.AllocHGlobal(8 + IntPtr.Size * capacity);
            try {
                bool ok = QueryInformationJobObject(job, 3, list, (uint)(8 + IntPtr.Size * capacity), IntPtr.Zero);
                int code = Marshal.GetLastWin32Error();
                if (!ok && code == 234 && capacity < 65536) { capacity *= 2; continue; }
                Check(ok, "OWNED_PID_LIST");
                int count = Marshal.ReadInt32(list, 4);
                if (count < 0 || count > capacity) throw new InvalidOperationException("PID_LIST_BOUND");
                for (int i=0; i<count; i++) Observe(job, checked((uint)Marshal.ReadIntPtr(list, 8 + i*IntPtr.Size).ToInt64()), trace);
                break;
            } finally { Marshal.FreeHGlobal(list); }
        }
    }
    static void Reap(Trace trace) {
        foreach (var p in trace.processes.Where(p => !p.reaped)) {
            long begin=Begin(trace);
            uint wait = WaitForSingleObject(p.handle, 0);
            if (wait == 0x102) continue;
            Check(wait == 0, "PROCESS_WAIT");
            uint code; long created, exited, kernel, user;
            Check(GetExitCodeProcess(p.handle, out code), "PROCESS_EXIT_CODE");
            Check(GetProcessTimes(p.handle, out created, out exited, out kernel, out user), "EXIT_TIMES");
            if (created != p.creation || GetProcessId(p.handle) != p.pid || exited == 0) throw new InvalidOperationException("EXIT_IDENTITY_MISMATCH");
            p.exit_utc=Utc(exited); p.exit_code=unchecked((int)code);
            Record(trace,"exit",p.binding_id,begin,new {pid=p.pid,creation_filetime=created.ToString(),handle_binding=p.handle_binding,wait_result=wait,exit_utc=p.exit_utc,exit_code=p.exit_code});
            if (p.pid == trace.root_pid && p.creation_filetime == trace.root_creation_filetime) { trace.root_exit_observed=true; trace.root_exit_code=p.exit_code; trace.root_exit_utc=p.exit_utc; }
            // Keep exited object handles until final release so repeat discovery can
            // compare actual objects, including already-exited processes.
            p.reaped=true;
        }
    }
    static Accounting Account(IntPtr job, Trace trace, string purpose, bool invalid) {
        long begin=Begin(trace);
        Accounting a;
        bool ok = QueryInformationJobObject(invalid ? new IntPtr(-1) : job, 1, out a, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero);
        int error = Marshal.GetLastWin32Error();
        var q = new Query { observed_utc=Now(), purpose=purpose, succeeded=ok, active_processes=ok ? (uint?)a.Active : null,
            total_processes=ok ? (uint?)a.Total : null, win32_error=ok ? null : (int?)error };
        // Retain transitions and every failure/zero; avoid unbounded polling logs.
        if (!ok || a.Active == 0 || trace.accounting.Count == 0 || trace.accounting.Last().active_processes != a.Active) {
            q.event_sequence=Record(trace,"account","job",begin,new {observed_utc=q.observed_utc,purpose=q.purpose,succeeded=q.succeeded,active_processes=q.active_processes,total_processes=q.total_processes,win32_error=q.win32_error});
            trace.accounting.Add(q);
        }
        if (!ok) throw new Win32Exception(error, "ACCOUNTING_QUERY_FAILED");
        if (a.Active == 0) { trace.zero_observed=true; trace.total_processes=a.Total; }
        return a;
    }
    static Trace Run(string exe, string[] args, string[] inputs, string cwd, string outputDir, string stop, string fixtureFault, IntPtr supervisor, string stageId) {
        var trace = new Trace { evidence_class=fixtureFault == null ? "application-native" : "offline-native-fixture", started_utc=Now() };
        trace.omitLimit = fixtureFault == "incomplete-history" ? 4 : 0;
        IntPtr job=IntPtr.Zero, port=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero, input=IntPtr.Zero, attributes=IntPtr.Zero, handles=IntPtr.Zero;
        bool attributesReady=false, assigned=false, created=false; ProcessInfo process=new ProcessInfo();
        var clock=Stopwatch.StartNew(); long rootExitAt=-1, zeroBeforeExitAt=-1;
        try {
            long frequency,oc,oe,ok,ou;
            if(fixtureFault=="qpc-failure" || !QueryPerformanceFrequency(out frequency) || frequency<=0)throw new InvalidOperationException("QPC_FREQUENCY_FAILED");
            using(var observer=Process.GetCurrentProcess()) {
                Check(GetProcessTimes(observer.Handle,out oc,out oe,out ok,out ou),"OBSERVER_CREATION");
                trace.ordering=new Ordering {frequency=frequency.ToString(),session_id=Guid.NewGuid().ToString("N"),observer_pid=(uint)observer.Id,observer_creation_filetime=oc.ToString(),thread_id=GetCurrentThreadId(),stage_id=stageId};
            }
            if(Valid(supervisor)) {
                Check(GetProcessTimes(supervisor,out oc,out oe,out ok,out ou),"JOURNAL_SUPERVISOR_CREATION");
                trace.ordering.supervisor_pid=GetProcessId(supervisor);trace.ordering.supervisor_creation_filetime=oc.ToString();
            }
            if(fixtureFault=="journal-overflow")trace.ordering.capacity=1;
            trace.reverseAudit=fixtureFault=="utc-reversal";
            Record(trace,"stage_begin","stage",Begin(trace),new {utc=trace.started_utc});
            long journalBegin=Begin(trace);
            if (IntPtr.Size != 8) throw new InvalidOperationException("X64_REQUIRED");
            Ordinary(exe, false);
            job=CreateJobObjectW(IntPtr.Zero, null); Check(Valid(job), "CREATE_JOB");
            var limit=new ExtendedLimit(); limit.Basic.Flags=fixtureFault == "breakaway" ? 0x2800U : 0x2000U;
            Check(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimit))), "JOB_LIMITS");
            ExtendedLimit actualLimits;
            Check(QueryInformationJobObject(job,9,out actualLimits,(uint)Marshal.SizeOf(typeof(ExtendedLimit)),IntPtr.Zero),"READ_JOB_LIMITS");
            trace.containment.job_flags=actualLimits.Basic.Flags;
            uint jobHandleFlags; Check(GetHandleInformation(job,out jobHandleFlags),"JOB_HANDLE_FLAGS");
            trace.containment.non_inheritable=(jobHandleFlags & 1)==0;
            if(!trace.containment.non_inheritable)throw new InvalidOperationException("INHERITABLE_JOB_HANDLE");
            trace.containment.job_handle_binding="retained-job:0x"+job.ToInt64().ToString("x");
            if(actualLimits.Basic.Flags != 0x2000) throw new InvalidOperationException("BREAKAWAY_OR_UNEXPECTED_LIMITS");
            Record(trace,"job_ready","job",journalBegin,new {job_handle_binding=trace.containment.job_handle_binding,flags=actualLimits.Basic.Flags,non_inheritable=trace.containment.non_inheritable});
            port=CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1); Check(Valid(port), "COMPLETION_PORT");
            var completion=new Completion { Key=new IntPtr(1), Port=port };
            Check(SetInformationJobObject(job, 7, ref completion, (uint)Marshal.SizeOf(typeof(Completion))), "ASSOCIATE_PORT");
            var sa=new Security { Length=Marshal.SizeOf(typeof(Security)), Inherit=1 };
            output=CreateFileW(Path.Combine(outputDir,"stdout.log"),0x40000000,1,ref sa,1,0x80,IntPtr.Zero); Check(Valid(output),"STDOUT_NEW");
            error=CreateFileW(Path.Combine(outputDir,"stderr.log"),0x40000000,1,ref sa,1,0x80,IntPtr.Zero); Check(Valid(error),"STDERR_NEW");
            input=CreateFileW("NUL",0x80000000,3,ref sa,3,0x80,IntPtr.Zero); Check(Valid(input),"STDIN_NULL");
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            Check(size != IntPtr.Zero,"ATTRIBUTE_SIZE"); attributes=Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes,1,0,ref size),"ATTRIBUTES"); attributesReady=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size*3);
            Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"HANDLE_ALLOWLIST");
            var startup=new StartupEx(); startup.Info.Size=Marshal.SizeOf(typeof(StartupEx)); startup.Info.Flags=0x101;
            startup.Info.Input=input; startup.Info.Output=output; startup.Info.Error=error; startup.Attributes=attributes;
            var command=new StringBuilder(Quote(exe));
            if (String.Equals(exe,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe"),StringComparison.OrdinalIgnoreCase)) {
                if(args.Length!=4 || args[0]!="/d" || args[1]!="/s" || args[2]!="/c") throw new InvalidOperationException("CMD_ENVELOPE");
                // cmd /s /c uses its own quote grammar, not CRT backslash escaping.
                command.Append(" /d /s /c ").Append(args[3]);
            } else foreach(var arg in args) command.Append(' ').Append(Quote(arg));
            trace.launch=new Launch {executable_path=exe,arguments=args,command_line=command.ToString(),executable_sha256=Hash(File.ReadAllBytes(exe)),policy=fixtureFault == null ? "approved-focused-v1-direct-child" : "offline-fixture-direct-child",inputs=inputs.Select(p=>new Input {path=p,sha256=Hash(File.ReadAllBytes(Ordinary(p,false)))}).ToArray()};
            journalBegin=Begin(trace);
            Check(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref startup,out process),"CREATE_SUSPENDED");
            created=true; trace.root_pid=process.Pid;
            Record(trace,"create","root",journalBegin,new {pid=process.Pid,handle=Handle(process.Process),suspended=true});
            journalBegin=Begin(trace);
            Check(AssignProcessToJobObject(fixtureFault == "assignment-failure" ? new IntPtr(-1) : job,process.Process),"ASSIGN_BEFORE_RESUME"); assigned=true; trace.assigned_before_resume=true;
            Record(trace,"assign","root",journalBegin,new {pid=process.Pid,handle=Handle(process.Process),job_handle_binding=trace.containment.job_handle_binding,assigned=true});
            var root=Bind(process.Process,process.Pid,job,null,trace); trace.processes.Add(root); process.Process=IntPtr.Zero;
            trace.root_creation_filetime=root.creation_filetime;
            trace.containment.assigned_before_resume=true; trace.containment.membership_verified=root.membership_verified;
            journalBegin=Begin(trace); uint imageSize=32768; var image=new StringBuilder((int)imageSize);
            Check(QueryFullProcessImageNameW(root.handle,0,image,ref imageSize),"ROOT_IMAGE_QUERY"); trace.launch.image_path=image.ToString();
            if(!String.Equals(Path.GetFullPath(exe),Path.GetFullPath(trace.launch.image_path),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("ROOT_IMAGE_MISMATCH");
            Record(trace,"launch_verified",root.binding_id,journalBegin,trace.launch);
            if (fixtureFault == "pid-mismatch") Bind(root.handle,root.pid,job,root.creation+1,trace);
            journalBegin=Begin(trace); uint resume=ResumeThread(process.Thread);
            Check(resume == 1,"RESUME");
            Record(trace,"resume",root.binding_id,journalBegin,new {pid=root.pid,previous_suspend_count=resume});Close(ref process.Thread);
            Close(ref output); Close(ref error); Close(ref input);
            while (true) {
                Discover(job,port,trace); Reap(trace);
                if (File.Exists(stop)) throw new InvalidOperationException("INTERRUPTED");
                if (Valid(supervisor)) {
                    uint ownerWait=WaitForSingleObject(supervisor,0);
                    if(ownerWait==0) throw new InvalidOperationException("SUPERVISOR_EXITED");
                    Check(ownerWait==0x102,"SUPERVISOR_WAIT");
                }
                var a=Account(job,trace,"execution",fixtureFault == "query-failure");
                if (a.Active == 0) {
                    // Exit can occur BETWEEN the nonblocking handle check and accounting.
                    // Observe the handle, then obtain a fresh zero AFTER that observation.
                    Discover(job,port,trace); Reap(trace);
                    if (!trace.root_exit_observed || trace.processes.Any(p=>!p.reaped)) {
                        if(zeroBeforeExitAt<0)zeroBeforeExitAt=clock.ElapsedMilliseconds;
                        if(clock.ElapsedMilliseconds-zeroBeforeExitAt>=DrainMilliseconds)throw new InvalidOperationException("ZERO_WITHOUT_EXIT_OBSERVATION");
                        Thread.Sleep(5); continue;
                    }
                    a=Account(job,trace,"completion",false);
                    if(a.Active!=0)throw new InvalidOperationException("COMPLETION_ACCOUNTING_CHANGED");
                    if(a.Total < trace.processes.Count)throw new InvalidOperationException("IDENTITIES_EXCEED_LIFETIME");
                    trace.identity_inventory_complete=a.Total == trace.processes.Count;
                    if(trace.launch.executable_sha256 != Hash(File.ReadAllBytes(exe)) || trace.launch.inputs.Any(f=>f.sha256 != Hash(File.ReadAllBytes(f.path))))throw new InvalidOperationException("LAUNCH_INPUT_CHANGED");
                    trace.containment.same_job_handle=true; // This local job handle was never closed/reopened/reassigned.
                    trace.tree_completion_verified=true; trace.cleanup_succeeded=true; break;
                }
                if (trace.root_exit_observed) {
                    if (rootExitAt < 0) rootExitAt=clock.ElapsedMilliseconds;
                    if (clock.ElapsedMilliseconds-rootExitAt >= DrainMilliseconds) throw new InvalidOperationException("DESCENDANT_DRAIN_EXPIRED");
                }
                Thread.Sleep(5);
            }
        } catch (Exception ex) {
            trace.first_failure=ex is Win32Exception ? ((Win32Exception)ex).Message.Split('\r','\n')[0] : ex.Message;
        } finally {
            // Cleanup can only address this job or our own unassigned suspended root handle.
            if (!trace.cleanup_succeeded && created) {
                var cleanup=Stopwatch.StartNew();
                try {
                    trace.termination_requested=true;
                    if (assigned) Check(TerminateJobObject(job,0xc000013a),"TERMINATE_OWNED_JOB");
                    else { Check(TerminateProcess(process.Process,0xc000013a),"TERMINATE_UNASSIGNED_ROOT");
                        Check(WaitForSingleObject(process.Process,CleanupMilliseconds)==0,"UNASSIGNED_CLEANUP_BOUND");
                        trace.cleanup_succeeded=true; }
                    if (assigned) while (cleanup.ElapsedMilliseconds < CleanupMilliseconds) {
                        Discover(job,port,trace); Reap(trace);
                        var a=Account(job,trace,"cleanup",false);
                        if (a.Active == 0) {
                            trace.identity_inventory_complete=a.Total == trace.processes.Count && trace.processes.All(p=>p.reaped);
                            trace.cleanup_succeeded=true; break;
                        }
                        Thread.Sleep(5);
                    }
                } catch (Exception) { trace.cleanup_succeeded=false; }
            }
            // KILL_ON_JOB_CLOSE remains a final fail-safe; closing is never reported as observed zero.
            foreach(var p in trace.processes) if (!p.handle_closed) {
                try {Release(trace,p);}catch(Exception ex){trace.first_failure=trace.first_failure??ex.Message;Close(ref p.handle);p.handle_closed=true;}
            }
            try {long b=Begin(trace);Close(ref job);Record(trace,"job_release","job",b,new {closed=true});}
            catch(Exception ex){trace.first_failure=trace.first_failure??ex.Message;Close(ref job);}
            Close(ref process.Thread); Close(ref process.Process); Close(ref port); Close(ref output); Close(ref error); Close(ref input);
            if(attributesReady) DeleteProcThreadAttributeList(attributes);
            if(attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if(handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            trace.ended_utc=Now();
            try {
                Record(trace,"cleanup","stage",Begin(trace),new {succeeded=trace.cleanup_succeeded,termination_requested=trace.termination_requested});
                Record(trace,"stage_end","stage",Begin(trace),new {utc=trace.ended_utc});
                trace.ordering.complete=trace.tree_completion_verified && trace.cleanup_succeeded && !trace.termination_requested && trace.first_failure==null;
            }catch(Exception ex){trace.first_failure=trace.first_failure??ex.Message;}
        }
        if (trace.first_failure == null && trace.root_exit_code != 0) trace.first_failure="CHILD_EXIT_NONZERO";
        // Failed cleanup/identity never receives a reporter-compatible success projection.
        return trace;
    }
    static void Project(Trace trace, string outputDir) {
        if(!trace.tree_completion_verified || !trace.cleanup_succeeded || !trace.zero_observed || !trace.root_exit_observed || trace.termination_requested || trace.ordering==null || !trace.ordering.complete)return;
        var zero=trace.accounting.Last(q=>q.purpose=="completion" && q.succeeded && q.active_processes==0);
        trace.ownership=new Dictionary<string,object> {
            {"contract_version",3},{"ordering",trace.ordering},{"root_pid",trace.root_pid},{"root_creation_filetime",trace.root_creation_filetime},
            {"root_exit_observed",true},{"root_exit_utc",trace.root_exit_utc},{"root_exit_code",trace.root_exit_code},
            {"query_succeeded",true},{"active_processes",0},{"zero_query_utc",zero.observed_utc},
            {"tree_completion_verified",true},{"cleanup_succeeded",true},{"termination_requested",false},
            {"launch",trace.launch},{"containment",trace.containment},{"command",trace.command},{"accounting",trace.accounting},
            {"historical",new Dictionary<string,object> {
                {"lifetime_process_count",trace.total_processes},{"retained_process_identities",trace.processes.Count},
                {"missing_identity_count",trace.total_processes.Value-trace.processes.Count},
                {"inventory_complete",trace.identity_inventory_complete},{"identities",trace.processes}
            }}
        };
        Write(Path.Combine(outputDir,"ownership.json"),trace.ownership);
    }
    public static string ObserveCreation(uint pid) {
        IntPtr h=OpenProcess(0x100000|0x1000,false,pid); Check(Valid(h),"OBSERVATION_HANDLE");
        try {
            long c,e,k,u; Check(GetProcessId(h)==pid,"OBSERVATION_PID");
            Check(GetProcessTimes(h,out c,out e,out k,out u),"OBSERVATION_CREATION");
            Check(WaitForSingleObject(h,0)==0x102,"OBSERVATION_PROCESS_NOT_LIVE"); return c.ToString();
        } finally { Close(ref h); }
    }
    public sealed class StageCommand { public string[] command, arguments, inputs; public string executable; }
    // Pure resolution: permits offline validation of the SAME parsing/quoting path used by RunStage.
    public static StageCommand InspectStage(string repo, string stageId) {
        byte[] bytes=File.ReadAllBytes(Ordinary(Path.Combine(repo,"scripts/validation/phase9-focused-v1.json"),false));
        if(Hash(bytes)!=ManifestHash) throw new InvalidOperationException("UNAPPROVED_MANIFEST");
        var manifest=Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes));
        var stages=((System.Collections.IEnumerable)manifest["stages"]).Cast<object>();
        var stage=stages.Cast<Dictionary<string,object>>().Single(s=>(string)s["id"]==stageId);
        var command=((System.Collections.IEnumerable)stage["command"]).Cast<string>().ToArray(); string exe;
        var args=command.Skip(1).ToArray();
        string nodeDir=Directory.GetDirectories(Path.Combine(repo,".tools"),"node-*-win-x64").Single();
        if(command[0]=="cargo") exe=Path.Combine(repo,".tools/cargo/bin/cargo.exe");
        else if(command[0]=="node") exe=Path.Combine(nodeDir,"node.exe");
        else if(command[0]=="npm.cmd" && command.SequenceEqual(new[]{"npm.cmd","run","build:web"})) {
            // cmd.exe is necessary to invoke the exact approved .cmd command. Never accepts shell text.
            exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe");
            args=new[]{"/d","/s","/c","\""+Quote(Path.Combine(nodeDir,"npm.cmd"))+" run build:web\""};
            Ordinary(Path.Combine(nodeDir,"npm.cmd"),false);
        } else throw new InvalidOperationException("UNAPPROVED_COMMAND");
        var inputs=new List<string>();
        if(command[0]=="npm.cmd")inputs.Add(Path.Combine(nodeDir,"npm.cmd"));
        if(command[0]=="node")inputs.Add(Path.GetFullPath(Path.Combine(repo,command[1].StartsWith("--") ? (string)stage["source_file"] : command[1])));
        return new StageCommand {command=command, arguments=args, inputs=inputs.ToArray(), executable=Ordinary(exe,false)};
    }
    public static Trace RunStage(string repo, string stageId, string outputDir, string stop, uint supervisorPid, string supervisorCreation) {
        OutputDirectory(repo,outputDir);
        foreach(var pair in new Dictionary<string,string>{{"PGHOST","127.0.0.1"},{"PGPORT","55433"},{"PGUSER","darkpool_test_maintenance"},{"PGDATABASE","postgres"},{"DARKPOOL_PG_ENV","TEST"},{"DARKPOOL_TEST_ONLY","TEST_ONLY"},{"ZCASH_NETWORK","testnet"}})
            if(Environment.GetEnvironmentVariable(pair.Key)!=pair.Value) throw new InvalidOperationException("TEST_ENVIRONMENT_REQUIRED");
        if(Environment.GetEnvironmentVariable("DARKPOOL_LIVE_INSTANCE")!=null) throw new InvalidOperationException("LIVE_SELECTOR_FORBIDDEN");
        string profile=Environment.GetEnvironmentVariable("DARKPOOL_PG_PROFILE");
        if(profile==null || !String.Equals(Path.GetFullPath(profile),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ZcashDarkPoolDev","postgres-test","profile.json"),StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("TEST_PROFILE_REQUIRED");
        foreach(System.Collections.DictionaryEntry pair in Environment.GetEnvironmentVariables())
            if(((string)pair.Key).StartsWith("PG",StringComparison.OrdinalIgnoreCase) && !new[]{"PGHOST","PGPORT","PGUSER","PGDATABASE","PGPASSWORD"}.Contains((string)pair.Key)) throw new InvalidOperationException("LIBPQ_OVERRIDE_FORBIDDEN");
        var stage=InspectStage(repo,stageId);
        IntPtr owner=OpenProcess(0x100000|0x1000,false,supervisorPid); Check(Valid(owner),"SUPERVISOR_HANDLE");
        try {
            long c,e,k,u; Check(GetProcessId(owner)==supervisorPid,"SUPERVISOR_PID");
            Check(GetProcessTimes(owner,out c,out e,out k,out u),"SUPERVISOR_CREATION");
            if(c.ToString()!=supervisorCreation)throw new InvalidOperationException("SUPERVISOR_CREATION_MISMATCH");
            var trace=Run(stage.executable,stage.arguments,stage.inputs,repo,outputDir,stop,null,owner,stageId); trace.command=stage.command;
            trace.supervisor_pid=supervisorPid; trace.supervisor_creation_filetime=c.ToString();
            Project(trace,outputDir);
            Write(Path.Combine(outputDir,"native-trace.json"),trace); return trace;
        } finally { Close(ref owner); }
    }
    // Offline seam is finite: it launches only fixed disposable fixtures, never application commands.
    // Faults are unavailable from RunStage and cannot change its accounting behavior.
    public static Trace RunFixture(string repo, string fixtures, string mode, string outputDir, string stop) {
        OutputDirectory(repo,outputDir);
        if(!new[]{"success","nonzero","short-descendant","persistent-descendant","query-failure","pid-mismatch","interrupt","nonzero-descendant","cmd-quoting","supervisor-exit","incomplete-history","assignment-failure","breakaway","utc-reversal","journal-overflow","qpc-failure"}.Contains(mode))
            throw new InvalidOperationException("UNKNOWN_FIXTURE");
        fixtures=Ordinary(fixtures,true);
        if(!fixtures.StartsWith(Path.Combine(Path.GetFullPath(repo),".tools","phase9-focused")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("FIXTURE_LOCATION");
        string exe=Ordinary(Path.Combine(fixtures,"fixture.exe"),false);
        string[] args=new[]{mode};
        if(mode=="cmd-quoting") {
            exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe");
            args=new[]{"/d","/s","/c","\""+Quote(Ordinary(Path.Combine(fixtures,"fixed fixture.cmd"),false))+" run build:web\""};
        }
        Process owner=null;
        try {
            long creation=0, exited, kernel, user;
            if(mode=="supervisor-exit") {
                owner=Process.Start(new ProcessStartInfo(exe,"leaf-short") { UseShellExecute=false, CreateNoWindow=true });
                Check(GetProcessTimes(owner.Handle,out creation,out exited,out kernel,out user),"OFFLINE_SUPERVISOR_TIMES");
            }
            var trace=Run(exe,args,mode=="cmd-quoting" ? new[]{Path.Combine(fixtures,"fixed fixture.cmd")} : new string[0],repo,outputDir,stop,mode,owner==null ? IntPtr.Zero : owner.Handle,"offline:"+mode); trace.command=new[]{"offline-fixture",mode};
            if(owner!=null) { trace.supervisor_pid=(uint)owner.Id; trace.supervisor_creation_filetime=creation.ToString(); }
            Project(trace,outputDir);
            Write(Path.Combine(outputDir,"native-trace.json"),trace); return trace;
        } finally {
            if(owner!=null) { if(!owner.HasExited) { owner.Kill(); if(!owner.WaitForExit(CleanupMilliseconds))throw new InvalidOperationException("OFFLINE_SUPERVISOR_CLEANUP"); } owner.Dispose(); }
        }
    }
}
