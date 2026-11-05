# Code signing and updates

Star ships unsigned by default. This document is the setup checklist for
Windows and macOS signing; do not commit certificate material or passwords.

## Windows

1. Obtain an EV/OV code-signing certificate (`.pfx` or a cloud HSM signer).
2. Add CI secrets:
   - `WINDOWS_CERT_PFX` — base64 of the `.pfx` file.
   - `WINDOWS_CERT_PASSWORD` — its password.
3. In the Windows build job, decode the certificate to a temp file and set
   `CSC_LINK` / `CSC_KEY_PASSWORD` for electron-builder, then delete the file
   in an `always()` cleanup step.
4. Set `WIN_CSC_LINK` only on protected branches; never print the secret.
5. Verify with `signtool verify /pa dist/Star-Setup-*.exe` before upload.

## macOS

1. Create a Developer ID Application certificate and an app-specific password.
2. Add secrets: `MAC_CERT_P12` (base64), `MAC_CERT_PASSWORD`,
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
3. Export the keychain in CI, set `CSC_LINK` / `CSC_KEY_PASSWORD`, and let
   electron-builder notarize with `notarize: true`.
4. Verify with `spctl --assess --type execute --verbose` and
   `codesign --verify --deep --strict`.

## Auto-update safety

- electron-builder emits `latest.yml` with SHA-512; the updater verifies it
  before installing.
- The app also checks the platform signature at install time: Windows
  `Get-AuthenticodeSignature`, macOS `codesign --verify`. An invalid signature
  is rejected; set `STAR_REQUIRE_SIGNATURE=1` to reject unsigned builds too.
- A failed download leaves no partial installer; a failed install keeps the
  previous version and surfaces the error instead of restarting into a broken
  build.
- Keep the current installer until the new version has started successfully;
  expose "Reinstall previous version" from About.
- Update checks are opt-in in tests and never run in embedded/side-chat views.
