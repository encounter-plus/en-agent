using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class EnAgentShortcut {
  [ComImport,Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}
  [ComImport,Guid("000214F9-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IShellLink {
    void GetPath([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int n,IntPtr data,int flags);
    void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int n);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string p);
    void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int n);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string p);
    void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int n);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string p);
    void GetHotkey(out short p);void SetHotkey(short p);void GetShowCmd(out int p);void SetShowCmd(int p);
    void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder p,int n,out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p,int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p,int reserved);void Resolve(IntPtr hwnd,int flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
  }
  public static void Create(string path,string target,string args){
    var link=(IShellLink)new ShellLink();try{link.SetPath(target);link.SetArguments(args);((IPersistFile)link).Save(path,true);}finally{Marshal.FinalReleaseComObject(link);}
  }
}
