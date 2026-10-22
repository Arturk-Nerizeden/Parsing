# Исследование GitHub

Дата: 22 октября 2026. Исходники прочитаны из HTTPS-клонов GitHub. Код расширения написан самостоятельно; сторонний код, ресурсы и скрипты не включены в поставку.

## Изученные проекты

| Проект и проверенный commit | Наблюдения | Решение для расширения |
|---|---|---|
| [morethanwords/tweb](https://github.com/morethanwords/tweb/tree/1da254bbb38f99abd06e61f005ca754792a80145) — Telegram Web K | DOM сообщения содержит `data-mid`, `data-peer-id`. В памяти клиента доступны сообщение, `fromId` и кеш peer. Дополнительные username имеют `pFlags.active`. | Основной режим авторов: сопоставлять DOM-сообщение с его автором через кеш, читать только активные публичные username. |
| [Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt/tree/f67a40879a7d78c2683ec5a296cf55bc22417d56) — Telegram Web A | `.Message[data-message-id]`, `.MessageList`, `.text-content`; имя отправителя не содержит username. Нажатие на отправителя открывает чат. | Независимый адаптер для упоминаний и ссылок; не обещать определение авторов по одному отображаемому имени. |
| [TheKoroushAsadi/telegram-group-member-scraper-chrome-extension](https://github.com/TheKoroushAsadi/telegram-group-member-scraper-chrome-extension/tree/d9391856469521cc4b99c2b31de515e355d50cad) | Пример Chrome-расширения: обход открытого списка участников, переход в профили, DOM-разбор и TXT. Username читается как второй ряд профиля; фиксированные задержки; широкое чтение профиля. | Подтверждает применимость content script, но позиционный разбор профилей не используем. Собираем авторов сообщений/комментариев; отдельно учитываем ошибки, отмену и источники. |

## Ключевые места исходников

- Web K: [bubbles.ts](https://github.com/morethanwords/tweb/blob/1da254bbb38f99abd06e61f005ca754792a80145/src/components/chat/bubbles.ts) — `.bubbles`, `.bubbles-inner`, `data-mid`, `data-peer-id`, `.message`, пересланные сообщения, переходы по имени автора.
- Web K: [apiManagerProxy.ts](https://github.com/morethanwords/tweb/blob/1da254bbb38f99abd06e61f005ca754792a80145/src/lib/apiManagerProxy.ts) — `getMessageByPeer(peerId, messageId)`, `getPeer(peerId)`, экспорт в `MOUNT_CLASS_TO.apiManagerProxy`.
- Web K: [debug.ts](https://github.com/morethanwords/tweb/blob/1da254bbb38f99abd06e61f005ca754792a80145/src/config/debug.ts) — `MOUNT_CLASS_TO` указывает на окно в изученной сборке. Это внутренний интерфейс, его наличие проверяется при каждом запуске.
- Web K: [getPeerActiveUsernames.ts](https://github.com/morethanwords/tweb/blob/1da254bbb38f99abd06e61f005ca754792a80145/src/lib/appManagers/utils/peers/getPeerActiveUsernames.ts) — активные имена из `usernames`, иначе `username`.
- Web K: [peerProfile.tsx](https://github.com/morethanwords/tweb/blob/1da254bbb38f99abd06e61f005ca754792a80145/src/components/peerProfile.tsx) — отдельное поле username, дополнительные имена; порядок рядов профиля зависит от доступных данных.
- Web A: [Message.tsx](https://github.com/Ajaxy/telegram-tt/blob/f67a40879a7d78c2683ec5a296cf55bc22417d56/src/components/middle/message/Message.tsx), [MessageList.tsx](https://github.com/Ajaxy/telegram-tt/blob/f67a40879a7d78c2683ec5a296cf55bc22417d56/src/components/middle/MessageList.tsx), [useInnerHandlers.ts](https://github.com/Ajaxy/telegram-tt/blob/f67a40879a7d78c2683ec5a296cf55bc22417d56/src/components/middle/message/hooks/useInnerHandlers.ts) — идентификаторы сообщений, область прокрутки, `handleSenderClick`.
- Пример расширения: [content.js](https://github.com/TheKoroushAsadi/telegram-group-member-scraper-chrome-extension/blob/d9391856469521cc4b99c2b31de515e355d50cad/telegram-group-member-scraper/scripts/content.js).

## Выводы и проверка

Комментарии — отдельная открытая переписка/ветка, поэтому сбор работает внутри текущей области сообщений. Чтение всей страницы захватывало бы боковую панель, другие чаты и цитаты. Адаптер ограничивает область текущим списком сообщений, исключает контейнеры удаляемых пузырей и служебные фрагменты текста.

Виртуализация удаляет старые DOM-узлы. Результаты и ID просмотренных сообщений накапливаются на каждом шаге прокрутки. Username объединяются без учёта регистра; author, mention и link остаются отдельными источниками.

MAIN-world bridge использует два read-only метода кеша клиента; дополнительно читает ID аккаунта и текущую ветку `appImManager.chat`, чтобы остановиться при переключении контекста. Он принимает максимум 500 пар `peerId`/`mid` за запрос, проверяет их наличие в DOM и возвращает ограниченные поля автора. Он не предоставляет вызов произвольных методов Telegram и не возвращает объект пользователя целиком.

В облачном Chromium обнаружена административная политика `ExtensionInstallBlocklist: ["*"]`; попытка штатной установки распакованного расширения отклонена. Полный набор `test:extension` сохранён для запуска в браузере, где установка разрешена. Политики среды не изменялись.

`test:browser` исполняет реальные файлы content script в изолированном мире Chromium, bridge — в основном мире страницы, код background — в VM. Только Chrome API заменены тестовыми реализациями. Сетевые ответы Telegram заменены контролируемыми страницами из `tests/fixtures.cjs`; форма разметки и кеша основана на прочитанных исходниках. Это проверяет сбор, отмену, изоляцию источников, сохранение и интерфейс, но не подтверждает установку Manifest V3 и интеграцию с настоящими Chrome API. Также необходим ручной smoke test в текущем авторизованном Telegram Web. GitHub HEAD и размещённая Telegram сборка могут различаться.
