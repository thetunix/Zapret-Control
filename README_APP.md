# Zapret Control Center

Electron-интерфейс для локального набора `Flowseal/zapret-discord-youtube`.
Файлы самого zapret лежат в папке `zapret/`, приложение Electron - в корне проекта.

## Запуск

```powershell
npm install
npm start
```

Для dev-запуска с UAC:

```powershell
npm run start:admin
```

Для реального запуска `winws.exe`, тестов и установки службы Windows приложению нужны права администратора.
Обычный `npm start` открывает окно без авто-UAC, чтобы dev-запуск не закрывался молча.

## Что есть

- запуск, остановка и перезапуск `zapret/bin/winws.exe` по существующим `zapret/general*.bat`;
- подхват уже запущенного `winws.exe` и управление им из интерфейса;
- автозапуск приложения с Windows и автоматическое включение лучшего конфига;
- проверка и применение обновлений zapret из `Flowseal/zapret-discord-youtube`;
- тесты конфигов по целям из `zapret/utils/targets.txt`;
- редактирование `zapret/lists/list-general-user.txt`;
- трей-режим при сворачивании;
- логи, настройка `game_filter.enabled`, 9 тем, живой glass-фон и управление службой `zapret`.
