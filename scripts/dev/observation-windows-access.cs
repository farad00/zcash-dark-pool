// SID-only Windows Authz evaluation. This is NOT a service/user logon test.
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class ObservationWindowsAccess {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Request {
    public uint DesiredAccess; public IntPtr PrincipalSelfSid;
    public IntPtr ObjectTypeList; public uint ObjectTypeListLength; public IntPtr OptionalArguments;
  }
  [StructLayout(LayoutKind.Sequential)] struct Reply {
    public uint ResultListLength; public IntPtr GrantedAccessMask; public IntPtr SaclEvaluationResults; public IntPtr Error;
  }
  [DllImport("authz.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool AuthzInitializeResourceManager(uint flags, IntPtr a, IntPtr b, IntPtr c, string name, out IntPtr manager);
  [DllImport("authz.dll", SetLastError=true)]
  static extern bool AuthzInitializeContextFromSid(uint flags, byte[] sid, IntPtr manager, IntPtr expiry, Luid id, IntPtr args, out IntPtr context);
  [DllImport("authz.dll", SetLastError=true)]
  static extern bool AuthzAccessCheck(uint flags, IntPtr context, ref Request request, IntPtr audit, byte[] sd, IntPtr extra, uint extraCount, ref Reply reply, IntPtr result);
  [DllImport("authz.dll")] static extern bool AuthzFreeContext(IntPtr context);
  [DllImport("authz.dll")] static extern bool AuthzFreeResourceManager(IntPtr manager);
  public static bool SidOnlyAccess(byte[] descriptor, string sidText, uint mask) {
    var sid = new SecurityIdentifier(sidText); var sidBytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(sidBytes, 0);
    IntPtr manager=IntPtr.Zero, context=IntPtr.Zero, granted=IntPtr.Zero, error=IntPtr.Zero;
    try {
      if (!AuthzInitializeResourceManager(1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, "ObservationFixture", out manager)) throw new InvalidOperationException("AUTHZ_UNAVAILABLE");
      // AUTHZ_SKIP_TOKEN_GROUPS: arbitrary synthetic SIDs, no existing account access.
      if (!AuthzInitializeContextFromSid(2, sidBytes, manager, IntPtr.Zero, new Luid(), IntPtr.Zero, out context)) throw new InvalidOperationException("AUTHZ_UNAVAILABLE");
      granted=Marshal.AllocHGlobal(4); error=Marshal.AllocHGlobal(4);
      Marshal.WriteInt32(granted, 0); Marshal.WriteInt32(error, 0);
      var req=new Request { DesiredAccess=mask };
      var rep=new Reply { ResultListLength=1, GrantedAccessMask=granted, Error=error };
      if (!AuthzAccessCheck(0, context, ref req, IntPtr.Zero, descriptor, IntPtr.Zero, 0, ref rep, IntPtr.Zero)) throw new InvalidOperationException("AUTHZ_UNAVAILABLE");
      int err=Marshal.ReadInt32(error);
      if (err != 0 && err != 5) throw new InvalidOperationException("AUTHZ_UNAVAILABLE");
      return err == 0 && (((uint)Marshal.ReadInt32(granted) & mask) == mask);
    } finally {
      if (granted!=IntPtr.Zero) Marshal.FreeHGlobal(granted); if (error!=IntPtr.Zero) Marshal.FreeHGlobal(error);
      if (context!=IntPtr.Zero) AuthzFreeContext(context); if (manager!=IntPtr.Zero) AuthzFreeResourceManager(manager);
      Array.Clear(sidBytes,0,sidBytes.Length);
    }
  }
}
