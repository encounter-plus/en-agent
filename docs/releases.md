# Сборки en-agent для GitHub Releases

Команды выполняются в PowerShell на Windows x64. Репозитории `en-agent` и `en-skills` должны лежать рядом. Нужны Node.js 24+, npm, pnpm, Windows PowerShell, .NET Framework 4.8 с C# compiler и заранее полученный бинарник OpenCode **2.0.32**. Путь к нему задаётся ниже. `npm run build` собирает только JavaScript launcher; для выпуска также нужны native EXE, skills и runtime.

## 1. Версии и сборка компонентов

Прочитайте [VERSIONING.md](../VERSIONING.md) и VERSIONING.md в en-skills. До упаковки обновите версии изменённых компонентов и lock-файлы. Для комплекта выберите новый ID и `sequence`, больший всех уже выпущенных значений канала. Номера launcher, skills, runtime и комплекта могут различаться. Приведённые ниже ID и sequence — примеры, а не проверенный следующий номер.

Из корня en-skills:

```powershell
npm ci
npm run check
npm run test:package
pnpm --dir runtime install --frozen-lockfile
pnpm --dir runtime validate
```

Из корня en-agent:

```powershell
npm ci
npm test
powershell -NoProfile -File windows/build.ps1 -Out dist/en-agent.exe
```

Остановитесь при ошибке любой команды. `npm test` сначала собирает JavaScript, а `windows/build.ps1` отдельно создаёт native launcher. Если подписываете EXE сертификатом Authenticode, добавьте `-CertificateThumbprint` уже на этом шаге, до вычисления хешей комплекта.

## 2. Собрать отдельный комплект

Далее все команды выполняются из корня en-agent в одной PowerShell-сессии. Замените ID, sequence и пути своими значениями; используйте новые выходные каталоги.

```powershell
$releaseId = '0.0.1'
$sequence = 103
$openCode = 'C:/tools/opencode/opencode.exe'
$seed = ".local/build-$releaseId"
$bundle = "$seed/releases/$releaseId"
$releaseOut = ".local/release-$releaseId"
$windowsOut = ".local/windows-$releaseId"
$key = 'C:/release-keys/en-agent-ed25519.pem'
node src/seed-local.mjs --home $seed --skills ../en-skills --opencode $openCode --id $releaseId --sequence $sequence
```

Seed копирует текущий Node, OpenCode, собранные скиллы, runtime, launcher и browser MCP; создаёт `release.json` с хешами и проверяет комплект. Это ещё не подписанный выпуск. Не используйте папку своей рабочей установки как выходной каталог.

## 3. Проверить комплект

```powershell
node tests/opencode-smoke.mjs $seed .local/games/release-smoke
node tests/memory-smoke.mjs $seed
npm run test:browser
```

Дополнительно запустите `en-agent.exe` из `$seed` и проверьте пользовательский путь на синтетической игре: создание/повторное открытие, три MCP, браузер и завершение работы. Перед stable нужны проверки обновления между двумя комплектами и сохранности данных, а также сценария автора на выбранной модели. Перечень проверок и границы автоматических тестов — в [техническом руководстве](technical.md). Успешная упаковка не заменяет эти проверки.

## 4. Ключ и подписанные файлы обновления

Для первого выпуска один раз создайте Ed25519-ключ вне репозитория. Каталог должен существовать; команда откажется перезаписывать существующий ключ:

```powershell
node --input-type=module -e 'import {generateKeyPairSync} from "node:crypto"; import {writeFileSync} from "node:fs"; const {privateKey}=generateKeyPairSync("ed25519"); writeFileSync(process.argv[1],privateKey.export({type:"pkcs8",format:"pem"}),{flag:"wx"});' $key
```

Для следующих выпусков используйте тот же ключ и храните его резервную копию отдельно. Замена ключа без перехода доверия нарушит обновление существующих установок. Приватный ключ никогда не прикладывается к Release.

Только после успешных проверок:

```powershell
node src/prepare-release.mjs --bundle $bundle --out $releaseOut --id $releaseId --sequence $sequence --key $key --approved
node src/package-windows.mjs --bundle $bundle --envelope "$releaseOut/channel.json" --public-key "$releaseOut/public-key.pem" --out $windowsOut
```

Результат: подписанный `channel.json`, публичный ключ, каталог `$releaseOut/$releaseId/` с файлами обновления, ZIP `en-agent-<ID>-windows-x64.zip` и его `.sha256`. Упаковщик включает только проверенные файлы комплекта, без чатов, игр и аккаунтов.

## 5. EXE-установщик (дополнительно к ZIP)

```powershell
$zip = "$windowsOut/en-agent-$releaseId-windows-x64.zip"
$setup = "$windowsOut/en-agent-$releaseId-windows-x64-setup.exe"
powershell -NoProfile -File windows/build.ps1 -Out $setup -Archive $zip
(Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash.ToLower() + "  en-agent-$releaseId-windows-x64-setup.exe" | Set-Content -Encoding ascii "$setup.sha256"
```

Для Authenticode-подписи установщика добавьте `-CertificateThumbprint` к его сборке. Контрольную сумму вычисляйте после подписи. Ed25519-подпись канала не заменяет Authenticode-подпись EXE.

## 6. Загрузка в GitHub Releases

1. Проверьте чистую распаковку ZIP и, если подготовлен, установщик.
2. Создайте draft Release в `encounter-plus/en-agent-updates` с тегом **точно равным `$releaseId`, без `v`**. В описании укажите коммит исходников из `en-agent`.
3. Только в `en-agent-updates` загрузите `$releaseOut/channel.json` и **все файлы внутри** `$releaseOut/$releaseId/` как отдельные assets с исходными именами SHA-256. Не загружайте этот каталог одним архивом: updater запрашивает каждый файл отдельно. Проверьте хеши и полноту набора.
4. Создайте draft Release в `encounter-plus/en-agent` с тем же тегом на коммите исходников. Добавьте **только четыре файла**: Windows ZIP, его `.sha256`, EXE-установщик и его `.sha256`. Не прикладывайте сюда манифест или файлы автообновления.
5. Опубликуйте проверенный канал в `en-agent-updates` как latest и проверьте обновление отдельной тестовой установки через опубликованные HTTPS-адреса. Затем публикуйте пользовательский Release в `en-agent` как latest. Предварительные выпуски помечайте prerelease; они не заменяют stable-канал.

Проверка доставки: `node tests/real-update-smoke.mjs <предыдущая-тестовая-установка> <releaseOut> --live`. Скрипт копирует прежнюю установку в отдельную временную папку, скачивает подписанный выпуск из опубликованного канала, запускает обновлённый комплект и проверяет сохранность синтетических данных и настроек. Для проверки нужен другой ID предыдущего комплекта и меньший sequence. Без `--live` файлы берутся из локального каталога поставки.

`public-key.pem` уже включён в настройку доверия Windows-комплекта. Не загружайте приватный ключ, seed целиком, `data/` или папки игр.

Все команды выше готовят файлы локально и ничего не публикуют. Автообновление использует `https://github.com/encounter-plus/en-agent-updates/releases/latest/download/channel.json`: draft и prerelease не доставляются по этому stable-каналу. Не удаляйте технические assets опубликованного канала. Для следующего выпуска сохраняйте прежний ключ подписи и увеличивайте sequence.
