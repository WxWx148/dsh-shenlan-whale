@echo off
chcp 65001 >nul
rem 机器人 QQ 必须与 config.json 里的 channel.selfId 一致。
rem NapCat 的 OneBot 网络配置是按 QQ 号分开存的（onebot11_<QQ号>.json）：
rem 号对不上，就会「登录成功、但那个号的配置里没有 WebSocket 服务端」，
rem 面板上永远停在「登录成功，等通道连上」。
rem
rem 插件启动时会带参数（call 启动NapCat.bat -q <selfId>），这里必须原样转给 NapCat；
rem 以前写死了 -q 1000000001，插件传进来的号会被丢掉 —— 启动的是旧号，不是当前机器人。
rem
rem 已经有 NapCat 在跑（WebUI 端口 6099 被占用）就直接退出。
rem 两份 NapCat 会抢 6099 和 3001，谁都给不了服务，还会让看门狗以为没在跑。
netstat -ano | findstr /c:"LISTENING" | findstr /c:":6099" >nul && exit /b 0
cd /d "%USERPROFILE%\.dsh\qq-fish\napcat\4.18.41"
if "%~1"=="" (
  call napcat.bat -q 1000000001
) else (
  call napcat.bat %*
)
exit /b %errorlevel%
