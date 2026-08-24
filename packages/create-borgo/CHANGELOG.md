# Changelog

## [0.21.0](https://github.com/LuigiDavideMicca/borgo/compare/create-borgo-v0.20.1...create-borgo-v0.21.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **borgogen:** request types are renamed to <Name>$Request and their fields are optional and nullable. A caller that constructed a request object with every field set still compiles; one that declared a variable of the old type name does not.
* **go:** freeze the go api for 1.0 and flush sse headers on open

### Features

* create-borgo asks about git, docker, vscode and a linter ([fab64ec](https://github.com/LuigiDavideMicca/borgo/commit/fab64ecc2425fd7bf7b7947fa0aa8dbe9e1a7b6f))
* create-borgo installs and starts what it just scaffolded ([6143196](https://github.com/LuigiDavideMicca/borgo/commit/61431964717e7856bd5ad6c40f9f48fc49fa9090))
* **go:** freeze the go api for 1.0 and flush sse headers on open ([8272431](https://github.com/LuigiDavideMicca/borgo/commit/82724318cacaa6b17b0172f0acbb31daa7f65ef1))


### Bug Fixes

* an unsafe /api request was proxied without any csrf check ([517a8fb](https://github.com/LuigiDavideMicca/borgo/commit/517a8fb55b7cfda1b23f77cfaced29511b99739b))
* **borgogen:** a request type promised fields the decoder never requires ([47d0761](https://github.com/LuigiDavideMicca/borgo/commit/47d07613bdfbf2209b1c815dd34bd5c3cfd5f23d))
* create-borgo asked questions it ignored, and shipped a command that exits 1 ([027cae5](https://github.com/LuigiDavideMicca/borgo/commit/027cae5d5967fac12ac22cad37306e68af325d3c))
* create-borgo told the truth about git only when git behaved ([375739f](https://github.com/LuigiDavideMicca/borgo/commit/375739f79ac3891db98a17a7b120275d0ee06b46))
* **create-borgo:** the default template promised an export that exited 1 ([192e803](https://github.com/LuigiDavideMicca/borgo/commit/192e8032225a0aef689cc4cc5a5cfbccab785e62))
* raise the front server's in-flight request cap ([9d2ad80](https://github.com/LuigiDavideMicca/borgo/commit/9d2ad80148c5f4d59b1bf769bc6f9d781f0cdc33))
* templates pass their own lint ([27f34b8](https://github.com/LuigiDavideMicca/borgo/commit/27f34b899836350c80792ad2f4fd57017ccd4563))
* the front server, the build, and every doc claim the code denied ([a1932e8](https://github.com/LuigiDavideMicca/borgo/commit/a1932e8b65783b8b86d08a20b0a48e3825cf18f1))
* the scaffold summary printed its own sentences under git's name ([534599d](https://github.com/LuigiDavideMicca/borgo/commit/534599d02b276ee9a13b21f7e2d330b7ce57ee7e))
* the second audit wave, and the regressions the first one caused ([c8dac83](https://github.com/LuigiDavideMicca/borgo/commit/c8dac8350cfed629c6803550a4f851abe6a2d5a2))
* the third pass, and the guards that failed open ([7880f3c](https://github.com/LuigiDavideMicca/borgo/commit/7880f3c2b2e7a0355c61fc931bff2d5979e25dc2))
* three ways the suite passed on windows and could not pass on linux ([ffe075b](https://github.com/LuigiDavideMicca/borgo/commit/ffe075ba151ca6d2f3bee6b9996e76fd8cff2aec))

## [0.20.1](https://github.com/LuigiDavideMicca/borgo/compare/create-borgo-v0.20.0...create-borgo-v0.20.1) (2026-07-31)


### Bug Fixes

* the full template sets a development session secret so login works day zero ([13d50fb](https://github.com/LuigiDavideMicca/borgo/commit/13d50fbb05c7270b15e3d96b4d6cff42efc08840))
* the scaffolder lets go of the terminal instead of hanging after its summary ([d51edfc](https://github.com/LuigiDavideMicca/borgo/commit/d51edfcd712a738c581651b8319487c4091bf68b))

## [0.20.0](https://github.com/LuigiDavideMicca/borgo/compare/create-borgo-v0.11.0...create-borgo-v0.20.0) (2026-07-31)


### Features

* create-borgo asks about tailwind and scaffolds it wired ([c1e41d9](https://github.com/LuigiDavideMicca/borgo/commit/c1e41d9b65d52cf9d1688bbbdf8f6ebf990dfd28))
* three create-borgo templates (minimal, base, full) with cli selection ([0b88680](https://github.com/LuigiDavideMicca/borgo/commit/0b8868065e8c2657382514f66bd43c3207d768de))


### Miscellaneous Chores

* cut the 0.20 release ([cd2503d](https://github.com/LuigiDavideMicca/borgo/commit/cd2503dd0ea7850f2f95c1b6cb4abdf0513a9b5f))

## [0.11.0](https://github.com/LuigiDavideMicca/borgo/compare/create-borgo-v0.10.1...create-borgo-v0.11.0) (2026-07-30)


### Features

* hardened http server with timeout env overrides and a 1 mb bind cap answering 413 end to end ([f1230aa](https://github.com/LuigiDavideMicca/borgo/commit/f1230aaa838192f82e2ac328f6b17c24c01880e4))
* systematic auth, borgo.Auth handlers over stdlib pbkdf2, Authed middleware and csrf-protected actions ([304b144](https://github.com/LuigiDavideMicca/borgo/commit/304b144ba275e738e1418ca4ac58fddbdef0f932))
* typed websocket events, borgo.PushT feeds a generated event map that types subscribe ([3eaad62](https://github.com/LuigiDavideMicca/borgo/commit/3eaad62964d6b638fda2a79297a9f1cde3757c51))


### Bug Fixes

* scaffold stamps the released borgo-framework version, template form carries the csrf field ([652d573](https://github.com/LuigiDavideMicca/borgo/commit/652d57376a8d47cb8731ad850af07c909f39ba9e))

## [0.10.0](https://github.com/LuigiDavideMicca/borgo/compare/create-borgo-v0.9.1...create-borgo-v0.10.0) (2026-07-29)


### Features

* add the create-borgo scaffolding cli ([7eb5fcc](https://github.com/LuigiDavideMicca/borgo/commit/7eb5fcc8deb4911a4cdafac950a9a04351ac02bc))
* attribution on template landing, readme and cli output ([03c620d](https://github.com/LuigiDavideMicca/borgo/commit/03c620daffe7982aa7356f1799968b8d4fa41fbb))
* branded cli and server output ([8906f7e](https://github.com/LuigiDavideMicca/borgo/commit/8906f7eb7fc235ab19b7ce7dd3690a7fbfd60c36))
* complete the typed bridge - helpers, writejson, type overrides, typed request bodies ([d9471ee](https://github.com/LuigiDavideMicca/borgo/commit/d9471eef83e524ba0ea5d97ca2349374db168198))
* deploy story - dockerfiles, compose, deploy guide, split-mode start ([6bc02d6](https://github.com/LuigiDavideMicca/borgo/commit/6bc02d632a0dff0af48f869ede2bcbabfad90c38))
* first-class server-sent events ([dd0b714](https://github.com/LuigiDavideMicca/borgo/commit/dd0b7140cb71f096dfadb4d31fa0a4778d7e8db9))
* per-page code splitting with lazy route chunks ([454493b](https://github.com/LuigiDavideMicca/borgo/commit/454493bea3b88f33540b850d9f51ab87536d4469))
* route directives replace init boilerplate ([82f891e](https://github.com/LuigiDavideMicca/borgo/commit/82f891ed051895d340fdbe7265772535ea726234))
* the borgo logo and a branded template ([dca83d6](https://github.com/LuigiDavideMicca/borgo/commit/dca83d667e1876f360658c7e80b14be01765284c))
* typed go-to-ts bridge via borgogen ([eef2c27](https://github.com/LuigiDavideMicca/borgo/commit/eef2c27b18786c3117fcc8382c40bfe1a54e591e))


### Bug Fixes

* document the bun shim path failure and the safe ways around it ([f6404d0](https://github.com/LuigiDavideMicca/borgo/commit/f6404d039255befde493e109dfe29a11ae1befd1))
* fall back to ascii marks on legacy windows consoles ([f4ef03d](https://github.com/LuigiDavideMicca/borgo/commit/f4ef03dd95ccd6187b56a8746e350bbe4bce0100))
* include generated api types in the ts program ([9046b25](https://github.com/LuigiDavideMicca/borgo/commit/9046b25debb65bf152ae8ccd14bb790d3aedeeeb))
* publish the runtime as borgo-framework, npm rejects the short name ([1c8d5ca](https://github.com/LuigiDavideMicca/borgo/commit/1c8d5caa7128fc3eb137715d91eb14edccb46d0d))
* scaffold ships pregenerated api types so the client is typed before the first dev run ([03b8dca](https://github.com/LuigiDavideMicca/borgo/commit/03b8dca5bb922b34aa06f76d93560357688cc777))
* treat piped windows output as legacy too, powershell decodes it as ansi ([a9450df](https://github.com/LuigiDavideMicca/borgo/commit/a9450df0684907b1ab68c5e9a1718be66c8837b4))

## 0.9.0 (2026-07-29)


### Features

* add the create-borgo scaffolding cli ([7eb5fcc](https://github.com/LuigiDavideMicca/borgo/commit/7eb5fcc8deb4911a4cdafac950a9a04351ac02bc))
* attribution on template landing, readme and cli output ([03c620d](https://github.com/LuigiDavideMicca/borgo/commit/03c620daffe7982aa7356f1799968b8d4fa41fbb))
* branded cli and server output ([8906f7e](https://github.com/LuigiDavideMicca/borgo/commit/8906f7eb7fc235ab19b7ce7dd3690a7fbfd60c36))
* complete the typed bridge - helpers, writejson, type overrides, typed request bodies ([d9471ee](https://github.com/LuigiDavideMicca/borgo/commit/d9471eef83e524ba0ea5d97ca2349374db168198))
* deploy story - dockerfiles, compose, deploy guide, split-mode start ([6bc02d6](https://github.com/LuigiDavideMicca/borgo/commit/6bc02d632a0dff0af48f869ede2bcbabfad90c38))
* first-class server-sent events ([dd0b714](https://github.com/LuigiDavideMicca/borgo/commit/dd0b7140cb71f096dfadb4d31fa0a4778d7e8db9))
* per-page code splitting with lazy route chunks ([454493b](https://github.com/LuigiDavideMicca/borgo/commit/454493bea3b88f33540b850d9f51ab87536d4469))
* route directives replace init boilerplate ([82f891e](https://github.com/LuigiDavideMicca/borgo/commit/82f891ed051895d340fdbe7265772535ea726234))
* the borgo logo and a branded template ([dca83d6](https://github.com/LuigiDavideMicca/borgo/commit/dca83d667e1876f360658c7e80b14be01765284c))
* typed go-to-ts bridge via borgogen ([eef2c27](https://github.com/LuigiDavideMicca/borgo/commit/eef2c27b18786c3117fcc8382c40bfe1a54e591e))


### Bug Fixes

* include generated api types in the ts program ([9046b25](https://github.com/LuigiDavideMicca/borgo/commit/9046b25debb65bf152ae8ccd14bb790d3aedeeeb))
