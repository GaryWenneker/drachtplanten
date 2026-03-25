# Netlify production deploy script  -  Drachtplant (Windows PowerShell 5.1 compatible)
#
# Voert de volledige deploy uit:
#   2A: next build direct (buiten netlify build, vermijdt EBUSY file-lock op Windows)
#   2B: netlify build met no-op command (alleen plugin-hooks: @netlify/plugin-nextjs)
#   3:  Kopieer public/ en _next/static naar .netlify/static
#   4:  Deploy pre-built (--no-build)
#   5:  Lock deploy
#   7:  HTTP health check
#
# Usage:
#   .\scripts\deploy-netlify.ps1
#   .\scripts\deploy-netlify.ps1 -SkipCommit
#   .\scripts\deploy-netlify.ps1 -SkipCommit -SkipPush
#   .\scripts\deploy-netlify.ps1 -SkipBuild        # hergebruik bestaande .next/standalone
#
# Params:
#   -SkipCommit  Geen git add/commit
#   -SkipPush    Geen git push na deploy
#   -SkipBuild   Sla next build over (gebruik bestaande .next/standalone)

param(
    [switch]$SkipCommit,
    [switch]$SkipPush,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
Set-Location $projectRoot

trap {
    Set-Location $scriptRoot
    break
}

Write-Host "Drachtplant  -  Netlify production deploy" -ForegroundColor Cyan
Write-Host "Project root: $projectRoot" -ForegroundColor Gray
Write-Host ""

# --- Prechecks ---
$netlifyInstalled = Get-Command netlify -ErrorAction SilentlyContinue
if (-not $netlifyInstalled) {
    Write-Host "ERROR: Netlify CLI niet gevonden. Installeer met: npm install -g netlify-cli" -ForegroundColor Red
    exit 1
}

$gitStatus = git status --porcelain 2>&1
$hasChanges = $LASTEXITCODE -eq 0 -and $gitStatus -ne ""

$didCommit = $false
if ($hasChanges -and -not $SkipCommit) {
    Write-Host "Stap 0: Git commit (wijzigingen gevonden)" -ForegroundColor Yellow
    git add -A

    # Veiligheidscheck: data/ mag NOOIT gestaged worden (bevat lokale trainingsafbeeldingen)
    $stagedData = git diff --staged --name-only 2>$null | Where-Object { $_ -match '^data/' }
    if ($stagedData) {
        Write-Host "ERROR: data/ bestanden zijn gestaged  -  check .gitignore!" -ForegroundColor Red
        $stagedData | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        git reset HEAD -- data/ 2>$null | Out-Null
        Write-Host "  data/ is teruggedraaid uit de staging area" -ForegroundColor Yellow
    }

    git diff --staged --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        $msg = Read-Host "Commit message (Enter = 'Deploy update')"
        if ([string]::IsNullOrWhiteSpace($msg)) {
            git commit -m "Deploy update"
        } else {
            git commit -m $msg
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Git commit mislukt" -ForegroundColor Red
            exit 1
        }
        $didCommit = $true
        Write-Host "OK: Gecommit" -ForegroundColor Green
    } else {
        Write-Host "Stap 0: Geen staged wijzigingen (alleen untracked/ignored)" -ForegroundColor Gray
    }
} elseif ($hasChanges -and $SkipCommit) {
    Write-Host "Stap 0: Overgeslagen (SkipCommit)" -ForegroundColor Yellow
} else {
    Write-Host "Stap 0: Geen wijzigingen om te committen" -ForegroundColor Gray
}
Write-Host ""

# --- Stap 1: Clean en link ---
Write-Host "Stap 1: Clean .next en .netlify, netlify link" -ForegroundColor Yellow
if ($SkipBuild) {
    Write-Host "  [1] SkipBuild: .next behouden (bestaande build hergebruikt)" -ForegroundColor DarkYellow
} else {
    Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force .netlify -ErrorAction SilentlyContinue
netlify link --name drachtplant
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: netlify link mislukt" -ForegroundColor Red
    exit 1
}
Write-Host "OK: Clean en link klaar" -ForegroundColor Green
Write-Host ""

# ============================================================
# STAP 2  -  TWEE-STAPS BUILD (vermijdt Windows EBUSY file-lock)
#
# Probleem: `netlify build` op Windows vergrendelt .next/ bestanden via VS Code
#   tsserver, waardoor .next/standalone/ NIET aangemaakt kan worden door de plugin.
#
# Oplossing:
#   2A: Draai `npm run build` DIRECT (buiten netlify build).
#       Next.js schrijft zelf .next/standalone/ via `output: 'standalone'` in config.
#   2B: Patch netlify.toml tijdelijk naar no-op build command.
#       Draai `netlify build` puur voor de plugin-hooks (onPreBuild / onPostBuild).
#       De plugin vindt .next/standalone/ en maakt .netlify/functions/___netlify-server-handler.
#   2C: Herstel netlify.toml.
# ============================================================

if (-not $SkipBuild) {
    # --- 2A-pre: Kill TypeScript language server (voorkomt EBUSY file-lock op .next/) ---
    Write-Host "  [2A-pre] Kill TypeScript language server processes (EBUSY preventie)" -ForegroundColor DarkCyan
    $tsserverProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "tsserver" }
    if ($tsserverProcs) {
        $tsserverProcs | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "  [2A-pre] Tsserver PID $($_.ProcessId) gestopt" -ForegroundColor DarkYellow
        }
        Start-Sleep -Seconds 2
    } else {
        Write-Host "  [2A-pre] Geen tsserver processen gevonden (OK)" -ForegroundColor Gray
    }

    # --- 2A-hide: Tijdelijk hernoemen van grote lokale mappen ---
    # Niet van toepassing - outputFileTracingExcludes in next.config.ts blokkeert data/ en models/.
    # Strip-stappen na de build ruimen eventuele restanten op uit de build-output mappen.

    # --- 2A: Directe npm build ---
    Write-Host "Stap 2: npm run build (direct, geen netlify build)" -ForegroundColor Yellow
    $npmLog = Join-Path $env:TEMP ("npm-build-log-" + [Guid]::NewGuid().ToString("n") + ".txt")
    $npmCmd = 'cd /d "' + $projectRoot + '" && npm run build > "' + $npmLog + '" 2>&1'
    cmd /c $npmCmd
    $npmExitCode = $LASTEXITCODE
    $npmOutputStr = Get-Content -Path $npmLog -Raw -ErrorAction SilentlyContinue
    Remove-Item -Path $npmLog -Force -ErrorAction SilentlyContinue

    if ($npmExitCode -ne 0) {
        $ebusyInOutput = $npmOutputStr -match "EBUSY: resource busy or locked"
        $standaloneExists = Test-Path (Join-Path $projectRoot ".next\standalone")

        if ($ebusyInOutput -and $standaloneExists) {
            Write-Host "  [2A] EBUSY gedetecteerd  -  standalone gedeeltelijk aangemaakt, herstel met robocopy" -ForegroundColor Yellow
            $srcNext = Join-Path $projectRoot ".next"
            $dstNext = Join-Path $projectRoot ".next\standalone\.next"

            # Kill alle node.exe processes voor robocopy
            Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match "tsserver" } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 3

            $null = robocopy $srcNext $dstNext /E /XO /XD "standalone" /R:5 /W:2 /NP /NJH /NJS 2>&1
            $roboCopied = $LASTEXITCODE

            if ($roboCopied -lt 8) {
                Write-Host "  [2A] EBUSY hersteld via robocopy (exit $roboCopied)" -ForegroundColor Green
                $npmExitCode = 0

                $standaloneJsPath = Join-Path $projectRoot ".next\standalone\server.js"
                if (-not (Test-Path $standaloneJsPath)) {
                    Write-Host "  [2A] standalone\server.js ontbreekt  -  npm build retry (15s wacht)..." -ForegroundColor Yellow
                    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                    Start-Sleep -Seconds 15
                    $npmLogRecovery = Join-Path $env:TEMP ("npm-build-recovery-" + [Guid]::NewGuid().ToString("n") + ".txt")
                    cmd /c ('cd /d "' + $projectRoot + '" && npm run build > "' + $npmLogRecovery + '" 2>&1')
                    $npmRecoveryExit = $LASTEXITCODE
                    $npmRecoveryOutput = Get-Content -Path $npmLogRecovery -Raw -ErrorAction SilentlyContinue
                    Remove-Item -Path $npmLogRecovery -Force -ErrorAction SilentlyContinue
                    if ($npmRecoveryExit -ne 0) {
                        if ($npmRecoveryOutput -match "EBUSY: resource busy or locked") {
                            $null = robocopy $srcNext $dstNext /E /XO /XD "standalone" /R:5 /W:2 /NP /NJH /NJS 2>&1
                            Write-Host "  [2A] EBUSY op recovery retry  -  robocopy nogmaals uitgevoerd" -ForegroundColor Yellow
                        } else {
                            Write-Host "ERROR: npm build recovery mislukt (exit $npmRecoveryExit)" -ForegroundColor Red
                            exit 1
                        }
                    }
                    if (-not (Test-Path $standaloneJsPath)) {
                        Write-Host "ERROR: standalone\server.js ontbreekt na recovery build" -ForegroundColor Red
                        exit 1
                    }
                    Write-Host "  [2A] standalone\server.js aanwezig na recovery build" -ForegroundColor Green
                }
            } else {
                Write-Host "ERROR: robocopy herstel mislukt (exit $roboCopied)" -ForegroundColor Red
                $errorLogPath = Join-Path $projectRoot "build-error.log"
                $npmOutputStr | Out-File -FilePath $errorLogPath -Encoding UTF8 -Force
                Write-Host "  [Buildlog opgeslagen: build-error.log]" -ForegroundColor Yellow
                exit 1
            }
        } else {
            Write-Host "ERROR: npm build mislukt (exit $npmExitCode):" -ForegroundColor Red
            $errorLogPath = Join-Path $projectRoot "build-error.log"
            $npmOutputStr | Out-File -FilePath $errorLogPath -Encoding UTF8 -Force
            Write-Host "  [Buildlog opgeslagen: build-error.log]" -ForegroundColor Yellow
            $buildLines = $npmOutputStr -split "`n"
            $errorPatterns = 'error TS|Type error|Module not found|Cannot find module|ENOENT|npm ERR!|Failed to compile|Build error|SyntaxError|ReferenceError|Cannot find name'
            $matchedErrors = $buildLines | Where-Object { $_ -match $errorPatterns }
            if ($matchedErrors) {
                Write-Host "  --- Gevonden foutregels ---" -ForegroundColor DarkRed
                $matchedErrors | Select-Object -First 25 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            } else {
                $buildLines | Select-Object -Last 50 | ForEach-Object { Write-Host "  $_" }
            }
            exit 1
        }
    }

    # Controleer of .next/standalone/ aangemaakt is
    $standaloneDir = Join-Path $projectRoot ".next\standalone"
    if (-not (Test-Path $standaloneDir)) {
        Write-Host "ERROR: .next\standalone\ niet gevonden na build." -ForegroundColor Red
        Write-Host "  Controleer of output: 'standalone' aanwezig is in next.config.ts" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  [2A] OK: npm build geslaagd (.next\standalone\ aangemaakt)" -ForegroundColor Green

    # --- 2A-post: Kopieer kleine public/ assets naar .next/standalone/public/ ---
    # Next.js standalone kopieert public/ NIET automatisch. De @netlify/plugin-nextjs
    # assembleert de Lambda vanuit .next/standalone/ - kleine assets (favicon, og-image, robots.txt)
    # moeten aanwezig zijn zodat de Lambda ze kan serveren indien de CDN ze mist.
    #
    # BELANGRIJK: grote media-mappen (photos/, images/, videos/, fonts/) worden NIET
    # gekopieerd naar standalone. Ze worden uitsluitend via de CDN geserveerd vanuit
    # .netlify/static/ (stap 3). Zo blijft de Lambda onder de 50 MB Netlify limiet.
    $standalonePub = Join-Path $projectRoot ".next\standalone\public"
    # Mappen die te groot zijn voor de Lambda en via CDN geserveerd worden:
    $excludeFromStandalone = @("photos", "images", "videos", "fonts", "uploads", "assets")
    if (Test-Path (Join-Path $projectRoot "public")) {
        if (-not (Test-Path $standalonePub)) {
            New-Item -ItemType Directory -Path $standalonePub -Force | Out-Null
        }
        # Kopieer alleen bestanden direct in public/ (geen mappen tenzij ze klein zijn)
        Get-ChildItem -Path (Join-Path $projectRoot "public") -ErrorAction SilentlyContinue | ForEach-Object {
            $item = $_
            if ($item.PSIsContainer) {
                # Sla grote media-mappen over
                if ($excludeFromStandalone -contains $item.Name.ToLower()) {
                    $skipSizeMB = [math]::Round((Get-ChildItem $item.FullName -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1)
                    Write-Host ("  [2A-post] SKIP public\{0}\ ({1} MB) -> CDN only" -f $item.Name, $skipSizeMB) -ForegroundColor DarkYellow
                } else {
                    # Klein map - kopieer wel (bijv. icons/)
                    $dest = Join-Path $standalonePub $item.Name
                    Copy-Item -Path $item.FullName -Destination $dest -Recurse -Force
                }
            } else {
                # Losse bestandjes (favicon.ico, robots.txt, og-image.png etc.)
                Copy-Item -Path $item.FullName -Destination $standalonePub -Force
            }
        }
        $pubCount = (Get-ChildItem $standalonePub -Recurse -File -ErrorAction SilentlyContinue).Count
        Write-Host "  [2A-post] public/ (kleine assets) gekopieerd naar .next\standalone\public\ ($pubCount bestanden)" -ForegroundColor Green
    }
    Write-Host ""

    # --- 2B: Patch netlify.toml -> no-op, run netlify build voor plugin-hooks ---
    Write-Host "  [2B] Patch netlify.toml -> no-op, run netlify build (plugin-hooks only)" -ForegroundColor DarkCyan
    $tomlPath     = Join-Path $projectRoot "netlify.toml"
    $tomlOriginal = [System.IO.File]::ReadAllText($tomlPath, [System.Text.UTF8Encoding]::new($false))
    $realCommand  = 'command = "npm run db:migrate && next build"'
    $noopCommand  = 'command = "echo netlify-plugin-only"'
    $tomlPatched  = $tomlOriginal.Replace($realCommand, $noopCommand)

    if ($tomlPatched -eq $tomlOriginal) {
        if ($tomlOriginal -match 'command\s*=\s*"echo ') {
            Write-Host "  [2B] netlify.toml heeft al een no-op command (vorige run)  -  OK" -ForegroundColor Gray
            $tomlPatched = $tomlOriginal
        } else {
            Write-Host "WAARSCHUWING: netlify.toml patch NIET toegepast (command-regel niet gevonden)" -ForegroundColor Yellow
            $tomlOriginal -split "`n" | Where-Object { $_ -match "command\s*=" } | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
        }
    }

    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tomlPath, $tomlPatched, $utf8NoBom)

    $buildLog = Join-Path $env:TEMP ("netlify-build-log-" + [Guid]::NewGuid().ToString("n") + ".txt")
    $buildCmd = 'cd /d "' + $projectRoot + '" && netlify build > "' + $buildLog + '" 2>&1'
    cmd /c $buildCmd
    $null = $LASTEXITCODE
    $buildOutputStr = Get-Content -Path $buildLog -Raw -ErrorAction SilentlyContinue
    Remove-Item -Path $buildLog -Force -ErrorAction SilentlyContinue

    # --- 2C: Herstel netlify.toml (altijd) ---
    Write-Host "  [2C] Herstel netlify.toml" -ForegroundColor DarkCyan
    [System.IO.File]::WriteAllText($tomlPath, $tomlOriginal, $utf8NoBom)

    # Controleer of de plugin de server handler aangemaakt heeft
    $handlerZip = Join-Path $projectRoot ".netlify\functions\___netlify-server-handler.zip"
    $handlerDir = Join-Path $projectRoot ".netlify\functions-internal\___netlify-server-handler"
    $pluginOk   = (Test-Path $handlerZip) -or (Test-Path $handlerDir)

    if (-not $pluginOk) {
        Write-Host "ERROR: @netlify/plugin-nextjs maakte GEEN server handler aan." -ForegroundColor Red
        if (-not [string]::IsNullOrWhiteSpace($buildOutputStr)) {
            $errorLogPath = Join-Path $projectRoot "build-error.log"
            $buildOutputStr | Out-File -FilePath $errorLogPath -Encoding UTF8 -Force
            Write-Host "  [Plugin-log opgeslagen: build-error.log]" -ForegroundColor Yellow
            $buildOutputStr -split "`n" | Select-Object -Last 60 | ForEach-Object { Write-Host "  $_" }
        }
        exit 1
    }

    # Grootte-check: handler ZIP / directory
    $handlerZipCheck = Join-Path $projectRoot ".netlify\functions\___netlify-server-handler.zip"
    $handlerDirCheck = Join-Path $projectRoot ".netlify\functions-internal\___netlify-server-handler"

    if (Test-Path $handlerZipCheck) {
        $zipKB = [math]::Round((Get-Item $handlerZipCheck).Length / 1KB, 0)
        if ($zipKB -lt 1024) {  # < 1 MB = waarschijnlijk corrupt
            Write-Host ("ERROR: server-handler.zip is slechts {0} KB  -  te klein voor een geldige build." -f $zipKB) -ForegroundColor Red
            exit 1
        }
        Write-Host ("  [2B] OK: server handler aangemaakt ({0} MB)" -f [math]::Round($zipKB / 1024, 1)) -ForegroundColor Green
    } elseif (Test-Path $handlerDirCheck) {
        $dirSizeKB = [math]::Round((Get-ChildItem $handlerDirCheck -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB, 0)
        Write-Host ("  [2B] OK: server handler (directory) aangemaakt ({0} MB)" -f [math]::Round($dirSizeKB / 1024, 1)) -ForegroundColor Green
    }

    # Als handler als directory bestaat maar geen ZIP -> pakken als ZIP
    $handlerInternalDir = Join-Path $projectRoot ".netlify\functions-internal\___netlify-server-handler"
    $handlerZipDest     = Join-Path $projectRoot ".netlify\functions\___netlify-server-handler.zip"
    if ((Test-Path $handlerInternalDir) -and (-not (Test-Path $handlerZipDest))) {
        Write-Host "  [2B] Handler in functions-internal\ -> ZIP aanmaken in .netlify\functions\" -ForegroundColor DarkCyan
        $functionsDir = Join-Path $projectRoot ".netlify\functions"
        if (-not (Test-Path $functionsDir)) { New-Item -ItemType Directory -Path $functionsDir -Force | Out-Null }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::CreateFromDirectory(
            $handlerInternalDir,
            $handlerZipDest,
            [System.IO.Compression.CompressionLevel]::Optimal,
            $false
        )
        $zipMB = [math]::Round((Get-Item $handlerZipDest).Length / 1MB, 1)
        Write-Host ("  [OK] ZIP aangemaakt: {0} MB" -f $zipMB) -ForegroundColor Green
    }

    # --- 2B-strip: Verwijder grote mappen uit build-output (nooit de originals) ---
    # outputFileTracingExcludes blokkeert de primaire bron; dit is de vangnet-stap.
    # Alleen paden BINNEN .next\standalone\ en .netlify\functions-internal\ worden geraakt.
    Write-Host "  [2B-strip] Strip lokale en media-mappen uit build-output" -ForegroundColor DarkCyan
    $stripDirs = @("data", "models", "scripts", "docs", "drizzle", ".git")
    # Grote media-mappen die via CDN geserveerd worden, mogen NOOIT in de Lambda zitten:
    $mediaStripDirs = @("photos", "images", "videos", "fonts", "uploads", "assets")
    $buildOutputRoots = @(
        (Join-Path $projectRoot ".next\standalone"),
        (Join-Path $projectRoot ".next\standalone\.next"),
        (Join-Path $projectRoot ".netlify\functions-internal\___netlify-server-handler")
    )
    $stripped = $false
    foreach ($root in $buildOutputRoots) {
        if (-not (Test-Path $root)) { continue }
        # Strip dev/data mappen
        foreach ($dir in $stripDirs) {
            $target = Join-Path $root $dir
            if (Test-Path $target) {
                $szMB = [math]::Round((Get-ChildItem $target -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1)
                Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue
                Write-Host ("  [2B-strip] {0} ({1} MB) uit {2}" -f $dir, $szMB, ($root.Replace($projectRoot + "\", ""))) -ForegroundColor DarkYellow
                $stripped = $true
            }
        }
        # Strip grote media-mappen zowel direct in root als genest in public/
        foreach ($media in $mediaStripDirs) {
            foreach ($mediaPath in @($media, "public\$media")) {
                $target = Join-Path $root $mediaPath
                if (Test-Path $target) {
                    $szMB = [math]::Round((Get-ChildItem $target -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1)
                    Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue
                    Write-Host ("  [2B-strip] {0} ({1} MB) [CDN-only] uit {2}" -f $mediaPath, $szMB, ($root.Replace($projectRoot + "\", ""))) -ForegroundColor DarkYellow
                    $stripped = $true
                }
            }
        }
    }
    if (-not $stripped) { Write-Host "  [2B-strip] Niets gevonden om te strippen (OK)" -ForegroundColor Gray }

    Write-Host ""

} # end if (-not $SkipBuild)

# --- Stap 2b-edge: Verwijder .netlify/edge-functions (Deno bundler ontbreekt op Windows) ---
# De Netlify CLI gebruikt Deno om edge functions te bundelen, maar Deno is niet
# geinstalleerd en de auto-download mislukt op Windows, waardoor de deploy wordt
# afgebroken met "Deploy aborted due to error while bundling edge functions".
# OPLOSSING: de Next.js middleware is al gecompileerd in ___netlify-server-handler
# (Lambda). De edge-functions zijn een CDN-niveau optimalisatie die NIET vereist
# is voor correcte werking van auth en RBAC. Verwijder de map zodat de CLI niets
# hoeft te bundelen.
Write-Host "Stap 2b-edge: Verwijder .netlify\edge-functions (Deno-bundler bypass)" -ForegroundColor Yellow
$edgeFunctionsDir = Join-Path $projectRoot ".netlify\edge-functions"
if (Test-Path $edgeFunctionsDir) {
    Remove-Item -Recurse -Force $edgeFunctionsDir -ErrorAction SilentlyContinue
    Write-Host "  [OK] .netlify\edge-functions\ verwijderd (middleware draait in Lambda)" -ForegroundColor Green
} else {
    Write-Host "  [OK] .netlify\edge-functions\ bestaat niet (skip)" -ForegroundColor Gray
}
Write-Host ""

# --- Stap 2b: Verwijder .next/cache/fetch-cache (Netlify Blobs 400-error preventie) ---
Write-Host "Stap 2b: Strip fetch-cache uit build-output" -ForegroundColor Yellow
$fetchCacheDir = Join-Path $projectRoot ".next\cache\fetch-cache"
if (Test-Path $fetchCacheDir) {
    $fetchCount = (Get-ChildItem $fetchCacheDir -File -EA SilentlyContinue).Count
    Remove-Item -Recurse -Force $fetchCacheDir -ErrorAction SilentlyContinue
    Write-Host "  [OK] .next\cache\fetch-cache\ verwijderd ($fetchCount entries)" -ForegroundColor Green
} else {
    Write-Host "  [OK] .next\cache\fetch-cache\ bestaat niet (skip)" -ForegroundColor Gray
}
$blobsDeployDir = Join-Path $projectRoot ".netlify\blobs\deploy"
if (Test-Path $blobsDeployDir) {
    Remove-Item -Recurse -Force $blobsDeployDir -ErrorAction SilentlyContinue
    Write-Host "  [OK] .netlify\blobs\deploy\ verwijderd" -ForegroundColor Green
}

# Controleer server-handler ZIP grootte (Netlify limiet: 50 MB)
$handlerZipPath = Join-Path $projectRoot ".netlify\functions\___netlify-server-handler.zip"
if (Test-Path $handlerZipPath) {
    $handlerZipMB = [math]::Round((Get-Item $handlerZipPath).Length / 1MB, 1)
    Write-Host ""
    Write-Host "  +--------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |  Pre-deploy Size Check                           |" -ForegroundColor Cyan
    Write-Host "  |--------------------------------------------------|" -ForegroundColor Cyan
    Write-Host ("  |  server-handler ZIP: {0,5} MB (limiet: 50 MB)   |" -f $handlerZipMB) -ForegroundColor Cyan
    Write-Host "  +--------------------------------------------------+" -ForegroundColor Cyan
    if ($handlerZipMB -gt 50) {
        Write-Host "  ABORT: server-handler.zip is $handlerZipMB MB  -  boven de 50 MB Netlify limiet." -ForegroundColor Red
        exit 1
    }
}
Write-Host ""

# --- Stap 3: Kopieer public files en _next/static naar .netlify\static ---
Write-Host "Stap 3: Kopieer public files en _next/static naar .netlify\static" -ForegroundColor Yellow
$staticDir = Join-Path $projectRoot ".netlify\static"
if (-not (Test-Path $staticDir)) {
    New-Item -ItemType Directory -Path $staticDir -Force | Out-Null
}

# 3a: Kopieer public/ recursief
if (Test-Path "public") {
    Get-ChildItem -Path "public" -ErrorAction SilentlyContinue | ForEach-Object {
        $dest = Join-Path $staticDir $_.Name
        if ($_.PSIsContainer) {
            Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
        } else {
            Copy-Item -Path $_.FullName -Destination $dest -Force
        }
    }
    Write-Host "OK: public/ gekopieerd naar .netlify\static" -ForegroundColor Green
} else {
    Write-Host "  [SKIP] public/ map niet gevonden" -ForegroundColor DarkYellow
}

# 3b: Kopieer _next/static
$nextStaticSrc  = Join-Path $projectRoot ".next\static"
$nextStaticDest = Join-Path $staticDir "_next\static"
if (Test-Path $nextStaticSrc) {
    $nextDir = Join-Path $staticDir "_next"
    if (-not (Test-Path $nextDir)) { New-Item -ItemType Directory -Path $nextDir -Force | Out-Null }
    Copy-Item -Path $nextStaticSrc -Destination (Join-Path $staticDir "_next\static") -Recurse -Force
    $chunkCount = (Get-ChildItem -Path $nextStaticDest -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Host "OK: _next/static gekopieerd ($chunkCount bestanden)" -ForegroundColor Green
} else {
    Write-Host "ERROR: .next\static niet gevonden  -  build is mogelijk mislukt!" -ForegroundColor Red
    exit 1
}

# 3c: Verificatie van kritieke bestanden
# Next.js 14+ co-locates CSS inside chunks/ instead of a dedicated css/ directory.
$chunkDir = Join-Path $nextStaticDest "chunks"
$cssDir   = Join-Path $nextStaticDest "css"
$allOk = $true

# Chunks directory check
if (Test-Path $chunkDir) {
    $cnt = (Get-ChildItem -Path $chunkDir -File -ErrorAction SilentlyContinue).Count
    Write-Host ("  [OK] _next/static/chunks (JS): " + $cnt + " bestanden") -ForegroundColor Green
} else {
    Write-Host "  [FAIL] _next/static/chunks (JS): ONTBREEKT!" -ForegroundColor Red
    $allOk = $false
}

# CSS check: dedicated css/ directory (Next.js <14) OR .css files inside chunks/ (Next.js 14+)
if (Test-Path $cssDir) {
    $cnt = (Get-ChildItem -Path $cssDir -File -ErrorAction SilentlyContinue).Count
    Write-Host ("  [OK] _next/static/css (stylesheets): " + $cnt + " bestanden") -ForegroundColor Green
} else {
    # Next.js 14+ places CSS files inside chunks/ - check for .css files there
    $cssInChunks = @(Get-ChildItem -Path $nextStaticDest -Recurse -Filter "*.css" -File -ErrorAction SilentlyContinue)
    if ($cssInChunks.Count -gt 0) {
        Write-Host ("  [OK] _next/static/css (stylesheets): " + $cssInChunks.Count + " .css bestanden in chunks/ (Next.js 14+ co-located)") -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] _next/static/css (stylesheets): geen .css bestanden gevonden!" -ForegroundColor Red
        $allOk = $false
    }
}

if (-not $allOk) {
    Write-Host "ERROR: Kritieke bestanden ontbreken, deploy wordt afgebroken" -ForegroundColor Red
    exit 1
}
Write-Host ""

# --- Stap 4: Deploy pre-built ---
Write-Host "Stap 4: Deploy pre-built (.netlify\static + .netlify\functions)" -ForegroundColor Yellow

# We no longer lock deploys after this step (removed lockDeploy from stap 5).
# The interactive unlock prompt therefore never appears in normal runs.
# For safety, if a legacy lock exists, remove it via cmd /c so PowerShell does
# not mangle the JSON quotes passed to the Netlify CLI.
Write-Host "  [4-pre] Verwijder eventuele legacy deploy-lock" -ForegroundColor DarkGray
$knownLockedDeployIds = @("69c3d10e45cfe20079da578c")
foreach ($lid in $knownLockedDeployIds) {
    $unlockStr = (cmd /c "netlify api unlockDeploy --data `"{`\`"deploy_id`\`":`\`"$lid`\`"}`"" 2>&1) -join " "
    if ($unlockStr -match '"locked"\s*:\s*false') {
        Write-Host "  [4-pre] OK: legacy deploy $lid ontgrendeld" -ForegroundColor Green
    }
    # Silently ignore errors — the deploy may already be unlocked or superseded
}

# Run netlify deploy directly in PowerShell (no cmd /c, no stdin pipe).
Set-Location $projectRoot
$deployRawOutput = netlify deploy --prod --no-build --dir ".netlify\static" --functions ".netlify\functions" --skip-functions-cache 2>&1
$deployOutputStr = ($deployRawOutput | ForEach-Object { $_.ToString() }) -join "`n"

if ([string]::IsNullOrWhiteSpace($deployOutputStr)) {
    Write-Host "ERROR: Geen deploy-output ontvangen" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host $deployOutputStr
Write-Host ""

if ($deployOutputStr -notmatch "Deploy (complete|is live)" -and $deployOutputStr -notmatch "Production deploy is live") {
    Write-Host "ERROR: Deploy mislukt (zie output hierboven)" -ForegroundColor Red
    exit 1
}

# Uitlezen deploy_id uit output
$deployId = $null
$hexPattern = 'https://([0-9a-f]+)--drachtplant\.netlify\.app'
if ($deployOutputStr -match $hexPattern) {
    $deployId = $Matches[1]
}
if (-not $deployId) {
    $deploysPattern = 'deploys/([0-9a-f]{20,})'
    if ($deployOutputStr -match $deploysPattern) {
        $deployId = $Matches[1]
    }
}

if (-not $deployId) {
    Write-Host "WAARSCHUWING: deploy_id niet gevonden in output" -ForegroundColor Yellow
} else {
    Write-Host "OK: Deploy live. deploy_id: $deployId" -ForegroundColor Green
    # NOTE: We do NOT lock the deploy.  Locking causes an interactive prompt on
    # the next "netlify deploy --prod" run, which breaks Netlify Blobs auth (401)
    # when the prompt is suppressed via stdin pipe.  Leaving deploys unlocked is
    # safe; Netlify keeps the production deploy stable unless explicitly replaced.
}
Write-Host ""

# --- Stap 6: Git push (indien gecommit) ---
if (-not $SkipPush -and $didCommit) {
    Write-Host "Stap 6: Git push" -ForegroundColor Yellow
    # Git schrijft voortgangsinfo naar stderr; tijdelijk EAP op Continue zetten
    # zodat PowerShell 5.1 geen NativeCommandError gooit op onschuldige stderr-output.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $pushOutput = git push 2>&1
    $pushExitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP

    if ($pushExitCode -ne 0) {
        $pushStr = ($pushOutput | ForEach-Object { $_.ToString() }) -join "`n"
        if ($pushStr -match "no upstream branch|has no upstream") {
            # Branch heeft nog geen remote tracking branch - zet upstream automatisch
            $ErrorActionPreference = "Continue"
            $currentBranch = (git rev-parse --abbrev-ref HEAD 2>&1) | Select-Object -First 1
            $ErrorActionPreference = $prevEAP
            Write-Host "  [6] Upstream ontbreekt, stel in: origin/$currentBranch" -ForegroundColor DarkYellow
            $ErrorActionPreference = "Continue"
            git push --set-upstream origin $currentBranch 2>&1 | Out-Null
            $upstreamExitCode = $LASTEXITCODE
            $ErrorActionPreference = $prevEAP
            if ($upstreamExitCode -ne 0) {
                Write-Host "WAARSCHUWING: Git push --set-upstream mislukt" -ForegroundColor Yellow
            } else {
                Write-Host "OK: Gepusht (upstream ingesteld: origin/$currentBranch)" -ForegroundColor Green
            }
        } else {
            Write-Host "WAARSCHUWING: Git push mislukt (geen remote of niet geconfigureerd)" -ForegroundColor Yellow
            Write-Host ($pushStr) -ForegroundColor DarkGray
        }
    } else {
        Write-Host "OK: Gepusht" -ForegroundColor Green
    }
} elseif ($SkipPush) {
    Write-Host "Stap 6: Overgeslagen (SkipPush)" -ForegroundColor Gray
} else {
    Write-Host "Stap 6: Geen push nodig (geen commit gedaan)" -ForegroundColor Gray
}
Write-Host ""

# --- Stap 7: HTTP health check ---
Write-Host "Stap 7: HTTP health check (https://drachtplant.netlify.app)" -ForegroundColor Yellow
Start-Sleep -Seconds 8
$healthOk = $false
for ($i = 1; $i -le 3; $i++) {
    try {
        $ping = Invoke-WebRequest "https://drachtplant.netlify.app" -Method HEAD -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
        if ($ping.StatusCode -lt 400) {
            Write-Host ("OK: Site online  -  HTTP {0} (poging {1})" -f $ping.StatusCode, $i) -ForegroundColor Green
            $healthOk = $true
            break
        }
        Write-Host ("  Poging {0}: HTTP {1}" -f $i, $ping.StatusCode) -ForegroundColor Yellow
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        Write-Host ("  Poging {0}: HTTP {1} ({2})" -f $i, $statusCode, $_.Exception.Message) -ForegroundColor Yellow
    }
    if ($i -lt 3) { Start-Sleep -Seconds 10 }
}
if (-not $healthOk) {
    Write-Host "WAARSCHUWING: Site reageert niet correct na deploy." -ForegroundColor Red
    Write-Host "  Controleer https://app.netlify.com/projects/drachtplant voor deploy logs." -ForegroundColor Yellow
}
Write-Host ""

Write-Host "Deploy afgerond. Site: https://drachtplant.netlify.app" -ForegroundColor Cyan
if ($deployId) {
    Write-Host ("Deploy ID: " + $deployId) -ForegroundColor Gray
}

Set-Location $scriptRoot
