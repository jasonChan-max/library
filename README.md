# 图书馆自习室座位

ESP32-C3 用 USB 数据线连接 Windows 电脑。电脑上的 Hub 接收座位事件，同时更新管理员平台和访客查询页。

## 1. 在 Arduino IDE 编译与上传

1. 在 Arduino IDE 的附加开发板管理器网址中加入 Espressif 的稳定版索引 `https://espressif.github.io/arduino-esp32/package_esp32_index.json`，再在开发板管理器安装 **esp32 by Espressif Systems**。编译验证使用 3.3.12。 [Espressif 安装说明](https://github.com/espressif/arduino-esp32/blob/master/docs/en/installing.rst)
2. 在库管理器安装 **WebSockets**（Markus Sattler）、**ArduinoJson** 7.x、**Adafruit GFX Library**、**Adafruit SSD1306** 和 **Adafruit NeoPixel**。接受 Arduino IDE 推荐安装的 Adafruit BusIO 依赖。
3. 打开 `firmware/SmartSeat_ESP32C3/SmartSeat_ESP32C3.ino`，选择 **ESP32C3 Dev Module**。原生 USB 板型（如 ESP32-C3 SuperMini）将 **USB CDC On Boot** 设为 **Enabled**。如果 USB 接口是 CH340 或 CP210x 转 UART0，将该选项设为 **Disabled**。选择对应的 COM 口，点击「验证」和「上传」。 [Espressif USB CDC 说明](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)
4. 用按钮连接 **GPIO3** 和 **GND**。单板使用默认座位 `A01`。多板使用不同的 `SEAT_ID`，每块板对应一个 COM 口和一个桥接进程。上传后关闭串口监视器，释放 COM 口给桥接程序。

默认启用 USB 和单按钮模式。空闲时短按登记使用，使用中短按暂离，暂离时短按返回。按住约 1.5 秒释放座位，暂离时双击延长 5 分钟。单按钮模式由访客主动登记；若已接占位传感器，可把 `USE_OCCUPANCY_SENSOR` 改为 `1`，由 GPIO6 的低电平检测占位。若需用原来的 Wi‑Fi 上报，将 `USE_USB_SERIAL` 改为 `0`，再配置 Wi‑Fi 和 `WS_HOST`。

## 2. 启动 Hub 和 USB 桥接

在项目根目录用 PowerShell 启动 Hub。若缺少依赖，先运行 `npm install`。

```powershell
node server/index.js
```

另开一个 PowerShell，列出 COM 口并将示例的 `COM5` 改成板子实际的端口。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server\usb-bridge.ps1 -List
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server\usb-bridge.ps1 -Port COM5
```

- 管理员页面打开 `http://localhost:8080/`。
- 访客页面打开 `http://localhost:8080/visit`。
- 同一局域网的其他设备把 `localhost` 换成 Hub 电脑的局域网 IP。
- 插拔设备后桥接会重试连接。离线座位会显示「待确认」。再次上传固件前，用 Ctrl+C 停止桥接。

## 3. 让访客从家中访问

由图书馆在运行 Hub 的电脑上启用独立访客端口。USB-only 部署可将管理员和设备入口同时绑定到本机。如果还要在局域网内使用管理员平台或连接 Wi‑Fi 座位板，省略 `HUB_HOST` 设置，并在馆内网络访问 8080。

```powershell
$env:HUB_HOST = '127.0.0.1'
$env:PUBLIC_PORT = '8081'
node server/index.js
```

将图书馆的公网 HTTPS 域名反向代理到访客端口 `127.0.0.1:8081`。例如，同一电脑上的 Caddy 可使用下面的配置，将示例域名换成实际域名，并让公网 HTTPS 请求抵达代理。

```caddyfile
seats.example.org {
    reverse_proxy 127.0.0.1:8081
}
```

此端口的首页是访客页，只提供访客静态文件、座位摘要和实时事件流。8080 是馆内管理员及设备入口。访客在家中访问 HTTPS 域名即可，电脑、Hub 和座位设备需保持运行。 [Caddy 反向代理说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 验证

```powershell
node tests/smoke.js
node tests/browser-smoke.js
node tests/visitor-smoke.js
```

访客测试以模拟设备触发占用、暂离、返回、释放和断线，验证两个访客连接收到一致状态，以及访客端口无法访问管理员接口。
