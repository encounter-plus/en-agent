param([Parameter(Mandatory=$true)][string]$Out,[string]$Archive,[string]$CertificateThumbprint)
$ErrorActionPreference='Stop'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$arguments=@('/nologo','/target:winexe','/platform:x64',('/out:'+[IO.Path]::GetFullPath($Out)),'/reference:System.Windows.Forms.dll')
if ($Archive) { $arguments+=@('/define:SETUP','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',('/resource:'+[IO.Path]::GetFullPath($Archive)+',package.zip')) }
& $compiler @arguments (Join-Path $PSScriptRoot 'Bootstrap.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native bootstrap build failed' }
if ($CertificateThumbprint) {
  $certificate=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$CertificateThumbprint)
  $result=Set-AuthenticodeSignature -LiteralPath $Out -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
  if ($result.Status -ne 'Valid') { throw 'Authenticode verification failed' }
}
