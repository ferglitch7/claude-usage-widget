; Instalador de Claude Usage Widget (Inno Setup).
; Instalacion por usuario (sin admin) en %LOCALAPPDATA%, con acceso directo
; en el Menu Inicio y arranque automatico opcional.

#define MyAppName "Claude Usage Widget"
#define MyAppVersion "1.0"
#define MyAppExeName "ClaudeUsageWidget.exe"

[Setup]
AppId={{7C6E7C7A-3F0E-4B4B-9C4E-4C6A9E6C6B9A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\ClaudeUsageWidget
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=installer
OutputBaseFilename=ClaudeUsageWidget-Setup
Compression=lzma
SolidCompression=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "autostart"; Description: "Iniciar automaticamente con Windows"; GroupDescription: "Opciones adicionales:"

[Files]
Source: "dist\ClaudeUsageWidget.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Desinstalar {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Abrir {#MyAppName} ahora"; Flags: nowait postinstall skipifsilent

[Messages]
FinishedLabel=Listo. %n%nClaude Usage Widget queda como un icono naranja en la bandeja del sistema (junto al reloj, abajo a la derecha). Si no lo ves de inmediato, haz clic en la flechita %n^%n para mostrar iconos ocultos.%n%nClic izquierdo: ver tu uso. Clic derecho: iniciar sesion, actualizar o salir.

[UninstallDelete]
Type: files; Name: "{app}\cookies.local.json"
Type: dirifempty; Name: "{app}"
