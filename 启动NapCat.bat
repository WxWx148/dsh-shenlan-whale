@echo off
chcp 65001 >nul
rem ============================================================
rem  深蓝鲸 · NapCat 启动脚本（模板）
rem  用法：把下面的 YOUR_QQ 改成机器人 QQ 号，按需改 NAPCAT_DIR，
rem        然后在面板「通道 → NapCat 启动脚本」里填这个文件的绝对路径。
rem  不填也行：留空时插件会自己找常见的 NapCat 安装目录。
rem ============================================================

rem 机器人 QQ 必须与面板里的「机器人 QQ 号」(channel.selfId) 一致。
rem NapCat 的 OneBot 网络配置按 QQ 号分开存（onebot11_<QQ号>.json）：
rem 号对不上就会「登录成功、但那个号的配置里没有 WebSocket 服务端」，
rem 面板上永远停在「登录成功，等通道连上」。

set "YOUR_QQ=1000000001"
set "NAPCAT_DIR=%USERPROFILE%\.dsh\qq-fish\napcat\4.18.41"

rem 已经有 NapCat 在跑（WebUI 端口 6099 被占用）就直接退出。
rem 两份 NapCat 会抢 6099 和 3001，谁都给不了服务，还会让看门狗以为没在跑。
netstat -ano | findstr /c:"LISTENING" | findstr /c:":6099" >nul && exit /b 0

cd /d "%NAPCAT_DIR%"
if errorlevel 1 (
  echo [深蓝鲸] 找不到 NapCat 目录：%NAPCAT_DIR%
  echo [深蓝鲸] 请先装 NapCat，或把本文件里的 NAPCAT_DIR 改成你的实际路径。
  exit /b 1
)
call napcat.bat -q %YOUR_QQ%
exit /b 0
