// Native primitives and a fixed, synthetic-only one-shot SCM/batch probe.
// No database, wallet, network, arbitrary command, or persistent-target entrypoint.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

public static class ObservationNative {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TokenStats {
    public Luid TokenId, AuthenticationId; public long Expiration; public int Type, Impersonation;
    public uint DynamicCharged, DynamicAvailable, GroupCount, PrivilegeCount; public Luid Modified;
  }
  [StructLayout(LayoutKind.Sequential)] struct LsaString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LogonData {
    public uint Size; public Luid Id; public LsaString User, Domain, Package; public uint Type, Session; public IntPtr Sid;
  }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQos;
  }
  [StructLayout(LayoutKind.Sequential)] struct Privilege { public uint Count; public Luid Id; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProfileInfo {
    public uint Size, Flags; public string UserName, ProfilePath, DefaultPath, Server, Policy; public IntPtr Profile;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileInformation {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct ServiceStatus { public uint Type, State, Controls, Win32Exit, ServiceExit, Checkpoint, WaitHint; }
  [StructLayout(LayoutKind.Sequential)] struct ServiceConfig {
    public uint Type, Start, Error; public IntPtr Binary, Group; public uint Tag; public IntPtr Dependencies, Account, Display;
  }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LogonUserW(string user,string domain,IntPtr password,int type,int provider,out IntPtr token);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int type,IntPtr buffer,int length,out int needed);
  [DllImport("secur32.dll")] static extern uint LsaGetLogonSessionData(ref Luid id,out IntPtr data);
  [DllImport("secur32.dll")] static extern uint LsaFreeReturnBuffer(IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system,ref ObjectAttributes attributes,uint access,out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy,byte[] sid,LsaString[] rights,uint count);
  [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy,byte[] sid,out IntPtr rights,out uint count);
  [DllImport("advapi32.dll")] static extern uint LsaRemoveAccountRights(IntPtr policy,byte[] sid,bool all,IntPtr rights,uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr memory);
  [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system,string name,out Luid id);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeName(string system,ref Luid id,StringBuilder name,ref int size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenThreadToken(IntPtr thread,uint access,bool asSelf,out IntPtr token);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref Privilege state,int size,IntPtr old,IntPtr returned);
  [DllImport("userenv.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LoadUserProfileW(IntPtr token,ref ProfileInfo info);
  [DllImport("userenv.dll", SetLastError=true)] static extern bool UnloadUserProfile(IntPtr token,IntPtr profile);
  [DllImport("userenv.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool GetUserProfileDirectoryW(IntPtr token,StringBuilder path,ref uint size);
  [DllImport("userenv.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool DeleteProfileW(string sid,string path,string computer);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FileInformation information);
  [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetUserGetLocalGroups(string server,string user,uint level,uint flags,out IntPtr buffer,uint size,out uint read,out uint total);
  [DllImport("netapi32.dll")] static extern uint NetApiBufferFree(IntPtr buffer);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenSCManagerW(string machine,string database,uint access);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateServiceW(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string binary,string group,IntPtr tag,string deps,string account,IntPtr password);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenServiceW(IntPtr manager,string name,uint access);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ChangeServiceConfigW(IntPtr service,uint type,uint start,uint error,string binary,string group,IntPtr tag,string deps,string account,IntPtr password,string display);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle,int type,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool QueryServiceObjectSecurity(IntPtr service,uint info,byte[] descriptor,uint size,out uint needed);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool QueryServiceConfigW(IntPtr service,IntPtr config,uint size,out uint needed);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool QueryServiceStatus(IntPtr service,out ServiceStatus status);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool StartServiceW(IntPtr service,uint count,IntPtr args);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ControlService(IntPtr service,uint control,out ServiceStatus status);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DeleteService(IntPtr service);
  [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Nt(uint status) { if(status!=0) throw new Win32Exception((int)LsaNtStatusToWinError(status)); }
  public static string Hash(byte[] bytes) { using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
  static byte[] SidBytes(string value) { var sid=new SecurityIdentifier(value); var bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);return bytes; }
  public static void RequireFixtureName(string name) { if(!Regex.IsMatch(name ?? "", "^zdpt[0-9a-f]{12}[pvwsr]$")) throw new InvalidOperationException("FIXTURE_NAME_REQUIRED"); }
  static readonly Dictionary<string,string> BoundAccounts=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
  public static void BindFixtureAccount(string name,string sid){RequireFixtureName(name);if(BoundAccounts.ContainsKey(name)||BoundAccounts.Values.Contains(sid)||new NTAccount(Environment.MachineName,name).Translate(typeof(SecurityIdentifier)).Value!=sid)throw new InvalidOperationException("ACCOUNT_BINDING_REJECTED");BoundAccounts.Add(name,sid);}
  static void RequireBoundName(string name){RequireFixtureName(name);string sid;if(!BoundAccounts.TryGetValue(name,out sid)||new NTAccount(Environment.MachineName,name).Translate(typeof(SecurityIdentifier)).Value!=sid)throw new InvalidOperationException("ACCOUNT_BINDING_REJECTED");}
  static void RequireBoundSid(string sid){string name=BoundAccounts.FirstOrDefault(p=>p.Value==sid).Key;if(name==null)throw new InvalidOperationException("ACCOUNT_BINDING_REJECTED");RequireBoundName(name);}
  public static string DirectoryIdentity(string path){IntPtr f=CreateFileW(path,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);if(f==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());try{FileInformation i;Check(GetFileInformationByHandle(f,out i));if((i.Attributes&0x400)!=0)throw new InvalidOperationException("REPARSE_REJECTED");return i.Volume+":"+i.IndexHigh+":"+i.IndexLow;}finally{CloseHandle(f);}}
  public static string[] LocalGroups(string name){RequireFixtureName(name);IntPtr data=IntPtr.Zero;uint n,total;try{uint code=NetUserGetLocalGroups(null,name,0,0,out data,0xFFFFFFFF,out n,out total);if(code!=0)throw new Win32Exception((int)code);var result=new List<string>();for(int i=0;i<n;i++)result.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(data,i*IntPtr.Size)));return result.ToArray();}finally{if(data!=IntPtr.Zero)NetApiBufferFree(data);}}
  public static void RequireSid(IntPtr token,string expected) { using(var id=new WindowsIdentity(token)) if(id.User.Value!=expected) throw new InvalidOperationException("SID_MISMATCH"); }
  public static IntPtr Logon(string name,SecureString password,int type) {
    RequireBoundName(name); if(type!=4 && type!=5) throw new InvalidOperationException("LOGON_TYPE_REJECTED");
    IntPtr plain=Marshal.SecureStringToGlobalAllocUnicode(password), token=IntPtr.Zero;
    try { Check(LogonUserW(name,".",plain,type,0,out token));RequireSid(token,BoundAccounts[name]);return token; }catch{if(token!=IntPtr.Zero)CloseHandle(token);throw;}finally { Marshal.ZeroFreeGlobalAllocUnicode(plain); }
  }
  public static int DeniedLogon(string name,SecureString password,int type) {
    RequireBoundName(name); if(type!=2 && type!=3 && type!=4 && type!=5) throw new InvalidOperationException("LOGON_TYPE_REJECTED");
    IntPtr plain=Marshal.SecureStringToGlobalAllocUnicode(password), token=IntPtr.Zero;
    try { bool ok=LogonUserW(name,".",plain,type,0,out token);return ok ? 0 : Marshal.GetLastWin32Error(); }
    finally { if(token!=IntPtr.Zero)CloseHandle(token);Marshal.ZeroFreeGlobalAllocUnicode(plain); }
  }
  static IntPtr Policy() { var a=new ObjectAttributes();a.Length=(uint)Marshal.SizeOf(a);IntPtr p;Nt(LsaOpenPolicy(IntPtr.Zero,ref a,0x810,out p));return p; }
  public static void AddFixtureRights(string sid,string[] rights) {
    RequireBoundSid(sid);
    var permitted=new[]{"SeServiceLogonRight","SeBatchLogonRight","SeDenyInteractiveLogonRight","SeDenyRemoteInteractiveLogonRight","SeDenyNetworkLogonRight","SeDenyBatchLogonRight","SeDenyServiceLogonRight"};
    if(rights==null || rights.Any(r=>!permitted.Contains(r)) || rights.Distinct().Count()!=rights.Length)throw new InvalidOperationException("RIGHT_REJECTED");
    var values=new LsaString[rights.Length];IntPtr policy=Policy();
    try { for(int i=0;i<rights.Length;i++){values[i].Buffer=Marshal.StringToHGlobalUni(rights[i]);values[i].Length=(ushort)(rights[i].Length*2);values[i].MaximumLength=(ushort)(values[i].Length+2);}Nt(LsaAddAccountRights(policy,SidBytes(sid),values,(uint)values.Length)); }
    finally { foreach(var v in values)if(v.Buffer!=IntPtr.Zero)Marshal.FreeHGlobal(v.Buffer);LsaClose(policy); }
  }
  public static string[] Rights(string sid) {
    RequireBoundSid(sid);
    IntPtr policy=Policy(), data=IntPtr.Zero;uint count;
    try { uint status=LsaEnumerateAccountRights(policy,SidBytes(sid),out data,out count);if(status==0xC0000034)return new string[0];Nt(status);var list=new List<string>();
      for(int i=0;i<count;i++){var v=(LsaString)Marshal.PtrToStructure(IntPtr.Add(data,i*Marshal.SizeOf(typeof(LsaString))),typeof(LsaString));list.Add(Marshal.PtrToStringUni(v.Buffer,v.Length/2));}return list.OrderBy(s=>s,StringComparer.Ordinal).ToArray(); }
    finally{if(data!=IntPtr.Zero)LsaFreeMemory(data);LsaClose(policy);}
  }
  public static void RemoveFixtureRights(string sid) {RequireBoundSid(sid);IntPtr p=Policy();try{Nt(LsaRemoveAccountRights(p,SidBytes(sid),true,IntPtr.Zero,0));}finally{LsaClose(p);} }
  public static uint CurrentLogonType() {
    using(var id=WindowsIdentity.GetCurrent()) {
      int n;GetTokenInformation(id.Token,10,IntPtr.Zero,0,out n);IntPtr buffer=Marshal.AllocHGlobal(n),data=IntPtr.Zero;
      try { Check(GetTokenInformation(id.Token,10,buffer,n,out n));var s=(TokenStats)Marshal.PtrToStructure(buffer,typeof(TokenStats));Nt(LsaGetLogonSessionData(ref s.AuthenticationId,out data));var logon=(LogonData)Marshal.PtrToStructure(data,typeof(LogonData));if(new SecurityIdentifier(logon.Sid).Value!=id.User.Value)throw new InvalidOperationException("LOGON_SID_MISMATCH");return logon.Type; }
      finally{if(data!=IntPtr.Zero)LsaFreeReturnBuffer(data);Marshal.FreeHGlobal(buffer);}
    }
  }
  public sealed class EnabledPrivilege : IDisposable {
    IntPtr token, previous; bool changed;
    public EnabledPrivilege(string name) {
      Check(OpenProcessToken(GetCurrentProcess(),0x28,out token));previous=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Privilege)));Luid id;Check(LookupPrivilegeValue(null,name,out id));var p=new Privilege{Count=1,Id=id,Attributes=2};
      try{Check(AdjustTokenPrivileges(token,false,ref p,Marshal.SizeOf(typeof(Privilege)),previous,IntPtr.Zero));if(Marshal.GetLastWin32Error()!=0)throw new InvalidOperationException("PRIVILEGE_UNAVAILABLE");changed=true;}catch{Dispose();throw;}
    }
    public void Dispose(){if(token!=IntPtr.Zero){if(changed){var p=(Privilege)Marshal.PtrToStructure(previous,typeof(Privilege));Check(AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero));}CloseHandle(token);token=IntPtr.Zero;}if(previous!=IntPtr.Zero){Marshal.FreeHGlobal(previous);previous=IntPtr.Zero;}}
  }
  public static string ProfilePath(IntPtr token) { uint n=0;GetUserProfileDirectoryW(token,null,ref n);var s=new StringBuilder((int)n);Check(GetUserProfileDirectoryW(token,s,ref n));return s.ToString(); }
  public static IntPtr LoadProfile(IntPtr token,string name) {
    RequireBoundName(name);RequireSid(token,BoundAccounts[name]);var p=new ProfileInfo{Size=(uint)Marshal.SizeOf(typeof(ProfileInfo)),Flags=1,UserName=name};
    using(new EnabledPrivilege("SeBackupPrivilege"))using(new EnabledPrivilege("SeRestorePrivilege")){Check(LoadUserProfileW(token,ref p));}return p.Profile;
  }
  public static void UnloadProfile(IntPtr token,IntPtr profile){using(new EnabledPrivilege("SeBackupPrivilege"))using(new EnabledPrivilege("SeRestorePrivilege")){Check(UnloadUserProfile(token,profile));}}
  public static void DeleteFixtureProfile(string sid,string expectedPath,string name){RequireBoundName(name);if(BoundAccounts[name]!=sid||!String.Equals(Path.GetFileName(expectedPath),name,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PROFILE_PATH_REJECTED");using(new EnabledPrivilege("SeBackupPrivilege"))using(new EnabledPrivilege("SeRestorePrivilege")){Check(DeleteProfileW(sid,null,null));}}
  public static int RunBatchProbe(IntPtr token,string[] args){if(args.Length!=8||args[0]!="batch")throw new InvalidOperationException("BATCH_PROBE_ONLY");using(var context=WindowsIdentity.Impersonate(token)){return ObservationFixtureHost.Probe(args);}}
  static IntPtr Manager(){IntPtr p=OpenSCManagerW(null,null,3);if(p==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());return p;}
  static IntPtr Service(IntPtr manager,string name){RequireBoundName(name);IntPtr p=OpenServiceW(manager,name,0xF01FF);if(p==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());return p;}
  static void CheckServiceDacl(IntPtr service){uint n;QueryServiceObjectSecurity(service,4,null,0,out n);var bytes=new byte[n];Check(QueryServiceObjectSecurity(service,4,bytes,n,out n));var sd=new RawSecurityDescriptor(bytes,0);if((sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0||sd.DiscretionaryAcl.Count!=2)throw new InvalidOperationException("SERVICE_DACL_REJECTED");var seen=new HashSet<string>();foreach(GenericAce item in sd.DiscretionaryAcl){var a=item as CommonAce;if(a==null||a.AceType!=AceType.AccessAllowed||a.AceFlags!=AceFlags.None||!new[]{"S-1-5-18","S-1-5-32-544"}.Contains(a.SecurityIdentifier.Value)||!seen.Add(a.SecurityIdentifier.Value)||(a.AccessMask!=0x10000000&&a.AccessMask!=0xF01FF))throw new InvalidOperationException("SERVICE_DACL_REJECTED");}}
  public static void InstallFixtureService(string name,SecureString password,string binary) {
    RequireBoundName(name);IntPtr manager=Manager(),plain=Marshal.SecureStringToGlobalAllocUnicode(password),service=IntPtr.Zero;
    try {service=CreateServiceW(manager,name,name,0xF01FF,0x10,4,1,binary,null,IntPtr.Zero,null,".\\"+name,plain);if(service==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
      var sd=new RawSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)");var bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);
      IntPtr descriptor=Marshal.AllocHGlobal(bytes.Length);try{Marshal.Copy(bytes,0,descriptor,bytes.Length);bool present,defaulted;IntPtr dacl;Check(GetSecurityDescriptorDacl(descriptor,out present,out dacl,out defaulted));if(!present||dacl==IntPtr.Zero)throw new InvalidOperationException("NULL_SERVICE_DACL_REJECTED");
        // SE_SERVICE=2. Unlike the legacy service setter, this honors protected-DACL flags.
        uint code=SetSecurityInfo(service,2,0x80000004,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);if(code!=0)throw new Win32Exception((int)code);
      }finally{Marshal.FreeHGlobal(descriptor);}
      CheckServiceDacl(service);
    } finally {if(service!=IntPtr.Zero)CloseServiceHandle(service);CloseServiceHandle(manager);Marshal.ZeroFreeGlobalAllocUnicode(plain);}
  }
  static ServiceConfig Config(IntPtr service,out IntPtr data){uint n;QueryServiceConfigW(service,IntPtr.Zero,0,out n);data=Marshal.AllocHGlobal((int)n);try{Check(QueryServiceConfigW(service,data,n,out n));return (ServiceConfig)Marshal.PtrToStructure(data,typeof(ServiceConfig));}catch{Marshal.FreeHGlobal(data);data=IntPtr.Zero;throw;}}
  public static void RunFixtureService(string name,string expectedAccount,string expectedOldBinary,string binary) {
    IntPtr manager=Manager(),service=IntPtr.Zero,data=IntPtr.Zero;
    try {service=Service(manager,name);CheckServiceDacl(service);var config=Config(service,out data);if(config.Type!=0x10 || !new[]{3u,4u}.Contains(config.Start) || Marshal.PtrToStringUni(config.Binary)!=expectedOldBinary || !String.Equals(Marshal.PtrToStringUni(config.Account),expectedAccount,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("SERVICE_CONFIG_MISMATCH");
      Marshal.FreeHGlobal(data);data=IntPtr.Zero;ServiceStatus status;Check(QueryServiceStatus(service,out status));if(status.State!=1)throw new InvalidOperationException("SERVICE_NOT_STOPPED");
      Check(ChangeServiceConfigW(service,0xFFFFFFFF,3,0xFFFFFFFF,binary,null,IntPtr.Zero,null,null,IntPtr.Zero,null));Check(StartServiceW(service,0,IntPtr.Zero));
      var deadline=DateTime.UtcNow.AddSeconds(30);do{Check(QueryServiceStatus(service,out status));if(status.State==1)break;Thread.Sleep(100);}while(DateTime.UtcNow<deadline);
      if(status.State!=1 || status.Win32Exit!=0 || status.ServiceExit!=0)throw new InvalidOperationException("SERVICE_EXECUTION_UNCONFIRMED");
    }finally{if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(service!=IntPtr.Zero)CloseServiceHandle(service);CloseServiceHandle(manager);}
  }
  public static void DeleteFixtureService(string name,string expectedAccount,string expectedBinary) {
    IntPtr manager=Manager(),service=IntPtr.Zero,data=IntPtr.Zero;
    try {service=Service(manager,name);var c=Config(service,out data);if(Marshal.PtrToStringUni(c.Binary)!=expectedBinary || !String.Equals(Marshal.PtrToStringUni(c.Account),expectedAccount,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("SERVICE_CLEANUP_IDENTITY_MISMATCH");
      ServiceStatus st;Check(QueryServiceStatus(service,out st));if(st.State!=1){Check(ControlService(service,1,out st));var deadline=DateTime.UtcNow.AddSeconds(30);do{Check(QueryServiceStatus(service,out st));if(st.State==1)break;Thread.Sleep(100);}while(DateTime.UtcNow<deadline);if(st.State!=1)throw new InvalidOperationException("SERVICE_STOP_UNCERTAIN");}Check(DeleteService(service));
    }finally{if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(service!=IntPtr.Zero)CloseServiceHandle(service);CloseServiceHandle(manager);}
  }
  public static string[] Privileges(bool trim) {
    IntPtr token;if(!OpenThreadToken(GetCurrentThread(),0x28,true,out token)){if(Marshal.GetLastWin32Error()!=1008)throw new Win32Exception(Marshal.GetLastWin32Error());Check(OpenProcessToken(GetCurrentProcess(),0x28,out token));}int n;GetTokenInformation(token,3,IntPtr.Zero,0,out n);IntPtr bytes=Marshal.AllocHGlobal(n);
    try{Check(GetTokenInformation(token,3,bytes,n,out n));int count=Marshal.ReadInt32(bytes);var names=new List<string>();
      for(int i=0;i<count;i++){IntPtr at=IntPtr.Add(bytes,4+12*i);var id=(Luid)Marshal.PtrToStructure(at,typeof(Luid));int size=256;var name=new StringBuilder(size);Check(LookupPrivilegeName(null,ref id,name,ref size));string value=name.ToString();
        if(value!="SeChangeNotifyPrivilege"){names.Add(value);if(trim){var p=new Privilege{Count=1,Id=id,Attributes=4};Check(AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero));if(Marshal.GetLastWin32Error()!=0)throw new InvalidOperationException("TOKEN_TRIM_FAILED");}}
      }return names.ToArray();
    }finally{Marshal.FreeHGlobal(bytes);CloseHandle(token);}
  }
}

public sealed class ObservationFixtureService : ServiceBase {
  readonly string[] args;
  public ObservationFixtureService(string[] values,string name){args=values;ServiceName=name;AutoLog=false;CanStop=true;}
  protected override void OnStart(string[] unused){ThreadPool.QueueUserWorkItem(delegate {Thread.Sleep(100);int code=ObservationFixtureHost.Probe(args);ExitCode=code;Stop();});}
}
public static class ObservationFixtureHost {
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=32768};
  static string stage="HOST_INPUTS";
  static void Need(bool value){if(!value)throw new InvalidOperationException("HOST_REJECTED");}
  static void NoRedirect(string path){for(var p=new DirectoryInfo(Path.GetDirectoryName(path));p!=null;p=p.Parent)Need((p.Attributes&FileAttributes.ReparsePoint)==0);if(File.Exists(path))Need((File.GetAttributes(path)&FileAttributes.ReparsePoint)==0);}
  static void WriteNew(string path,byte[] bytes){using(var f=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.Write(bytes,0,bytes.Length);f.Flush(true);}}
  static void CheckPrivateAcl(string path,string sid){var acl=Directory.GetAccessControl(path);Need(acl.AreAccessRulesProtected);foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))Need(rule.AccessControlType==AccessControlType.Allow && new[]{sid,"S-1-5-18","S-1-5-32-544"}.Contains(rule.IdentityReference.Value));}
  public static int Probe(string[] a) {
    string result=null;
    try {
      var purposes=new[]{"postgres","viewer_controller","web","signer","backup_operator"};
      Need(a.Length==8 && new[]{"batch","service"}.Contains(a[0]) && Regex.IsMatch(a[2],"^[a-f0-9]{32}$") && purposes.Contains(a[3]) && new[]{"own","cross"}.Contains(a[6]) && Regex.IsMatch(a[7],"^[a-f0-9]{64}$"));
      string root=Path.GetFullPath(a[1]);Need(Path.GetFileName(root)=="darkpool-winsec-"+a[2]);NoRedirect(root+"\\scope.json");
      byte[] raw=File.ReadAllBytes(Path.Combine(root,"scope.json"));Need(ObservationNative.Hash(raw)==a[7]);
      var config=Json.Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(raw));
      Need((string)config["scope"]=="DISPOSABLE_WINDOWS_SECURITY_ONLY" && (string)config["root"]==root && (string)config["nonce"]==a[2] && (string)config["financial_authorization"]=="NOT_GRANTED");
      Need(ObservationNative.DirectoryIdentity(root)==(string)config["directory_identity"]);
      Need(ObservationNative.Hash(File.ReadAllBytes(Path.Combine(root,"bin","host.exe")))==(string)config["host_sha256"]);
      var accounts=(System.Collections.IEnumerable)config["accounts"];var map=new Dictionary<string,string>();string name=null;
      foreach(Dictionary<string,object> account in accounts){string p=(string)account["purpose"],sid=(string)account["sid"];Need(purposes.Contains(p)&&Regex.IsMatch(sid,"^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$"));ObservationNative.RequireFixtureName((string)account["name"]);map.Add(p,sid);if(p==a[3])name=(string)account["name"];}
      Need(map.Count==5 && map.Values.Distinct().Count()==5 && map[a[3]]==a[4]);ObservationNative.RequireFixtureName(name);Need(name==a[5]);
      string own=Path.Combine(root,"private",a[3]);result=Path.Combine(own,a[6]+"-result.json");
      stage="HOST_IDENTITY";using(var id=WindowsIdentity.GetCurrent()){Need(id.User.Value==a[4]);Need(!new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator));}
      stage="LOGON_TYPE";uint logon=ObservationNative.CurrentLogonType();Need(logon==(a[0]=="service"?5u:4u));
      stage="PROFILE";using(var id=WindowsIdentity.GetCurrent()){Need(Path.GetFileName(ObservationNative.ProfilePath(id.Token)).Equals(name,StringComparison.OrdinalIgnoreCase));}
      stage="TOKEN_RESTRICTION";ObservationNative.Privileges(true);Need(ObservationNative.Privileges(false).Length==0);
      stage="ACL_DENIAL";NoRedirect(Path.Combine(own,"synthetic.txt"));CheckPrivateAcl(own,a[4]);int denied=0;
      foreach(string other in map.Keys.Where(p=>p!=a[3])){
        string path=Path.Combine(root,"private",other,"synthetic.txt");NoRedirect(path);
        bool readDenied=false,writeDenied=false;try{File.ReadAllBytes(path);}catch(UnauthorizedAccessException){readDenied=true;}
        try{using(var f=new FileStream(path,FileMode.Open,FileAccess.Write)){} }catch(UnauthorizedAccessException){writeDenied=true;}
        Need(readDenied&&writeDenied);denied+=2;
      }
      bool toolDenied=false;try{using(var f=new FileStream(Path.Combine(root,"bin","host.exe"),FileMode.Open,FileAccess.Write)){} }catch(UnauthorizedAccessException){toolDenied=true;}Need(toolDenied);
      byte[] entropy=Encoding.UTF8.GetBytes("OBSERVATION_WINDOWS_DPAPI_FIXTURE_V1:"+a[2]);int cross=0;
      if(a[6]=="own") {
        stage="DPAPI_PROTECT";byte[] plain=new byte[32];using(var rng=RandomNumberGenerator.Create())rng.GetBytes(plain);
        byte[] blob=ProtectedData.Protect(plain,entropy,DataProtectionScope.CurrentUser),opened=ProtectedData.Unprotect(blob,entropy,DataProtectionScope.CurrentUser);Need(plain.SequenceEqual(opened));
        WriteNew(Path.Combine(own,"synthetic.dpapi"),blob);Array.Clear(plain,0,plain.Length);Array.Clear(opened,0,opened.Length);
      }else{
        stage="DPAPI_CROSS";byte[] ownBlob=File.ReadAllBytes(Path.Combine(own,"synthetic.dpapi"));byte[] ownPlain=ProtectedData.Unprotect(ownBlob,entropy,DataProtectionScope.CurrentUser);Need(ownPlain.Length==32);Array.Clear(ownPlain,0,ownPlain.Length);
        foreach(string other in map.Keys.Where(p=>p!=a[3])){bool rejected=false;try{var b=ProtectedData.Unprotect(File.ReadAllBytes(Path.Combine(root,"cross",other+".dpapi")),entropy,DataProtectionScope.CurrentUser);Array.Clear(b,0,b.Length);}catch(CryptographicException){rejected=true;}Need(rejected);cross++;}
      }
      var report=new Dictionary<string,object>{{"status","PASS"},{"scope","DISPOSABLE_WINDOWS_SECURITY_ONLY"},{"purpose",a[3]},{"sid",a[4]},{"logon_type",logon},{"phase",a[6]},{"acl_denials",denied},{"tool_write_denied",true},{"dpapi_roundtrip",true},{"cross_user_dpapi_denials",cross},{"residual_elevated_privileges",0},{"financial_authorization","NOT_GRANTED"}};
      WriteNew(result,Encoding.UTF8.GetBytes(Json.Serialize(report)));return 0;
    }catch{
      if(result!=null&&!File.Exists(result)){try{WriteNew(result,Encoding.UTF8.GetBytes(Json.Serialize(new{status="FAIL",stage=stage,financial_authorization="NOT_GRANTED"})));}catch{}}
      return 1;
    }
  }
  public static void Main(string[] args){
    if(args.Length==8&&args[0]=="service")ServiceBase.Run(new ObservationFixtureService(args,args[5]));
    else Environment.Exit(Probe(args));
  }
}
