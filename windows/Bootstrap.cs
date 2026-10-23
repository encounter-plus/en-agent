using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
#if SETUP
using System.IO.Compression;
#endif
[assembly: AssemblyVersion("0.0.1.0")]
[assembly: AssemblyFileVersion("0.0.1.0")]
[assembly: AssemblyProduct("en-agent")]
static class Bootstrap {
  [STAThread] static int Main(string[] args) {
    try {
#if SETUP
      AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
      AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
#endif
      if(args.Length==1 && args[0]=="--self-test")return 0;
      string home=Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
#if SETUP
      string temp=Path.Combine(Path.GetTempPath(),"ea-"+Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(temp);
      try {
        string archive=Path.Combine(temp,"package.zip");
        using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("package.zip"))
        using(var output=File.Create(archive))input.CopyTo(output);
        ZipFile.ExtractToDirectory(archive,Path.Combine(temp,"payload"));
        home=Directory.GetDirectories(Path.Combine(temp,"payload"))[0];
        return Run(home,"Install.ps1","");
      } finally { Directory.Delete(temp,true); }
#else
      if(args.Length>1)throw new Exception("Unsupported arguments");
      string option=args.Length==0?"":args[0];
      if(option=="--uninstall")return Run(home,"Uninstall.ps1","",false);
      if(option=="--install")return Run(home,"Install.ps1","");
      if(option!="" && option!="--resume")throw new Exception("Unsupported arguments");
      return Run(home,"Launch.ps1"," -HomeDirectory \""+home+"\""+(option=="--resume"?" -ResumeLastGame":""));
#endif
    } catch { MessageBox.Show("Не удалось запустить en-agent. Проверьте целостность установки.","en-agent",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1; }
  }
  static int Run(string home,string script,string options,bool wait=true) {
    string powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell\\v1.0\\powershell.exe");
    var info=new ProcessStartInfo(powershell,"-NoProfile -STA -ExecutionPolicy Bypass -File \""+Path.Combine(home,script)+"\""+options);
    info.UseShellExecute=false;info.CreateNoWindow=true;info.WindowStyle=ProcessWindowStyle.Hidden;info.WorkingDirectory=home;
    using(var child=Process.Start(info)){if(!wait)return 0;child.WaitForExit();return child.ExitCode;}
  }
}
