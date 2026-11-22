/* ============================================================================
 *  Smart Seat / 智能座位暂离管理系统
 *  ESP32-C3 设备端固件  ——  SmartSeat_ESP32C3.ino
 *  FW_VERSION 1.1.0   |   Protocol 1.0.0
 * ============================================================================
 *
 * 默认使用 USB 串口接入：用数据线连接 Windows 电脑，启动 Hub，再运行
 * server/usb-bridge.ps1。首次短按登记使用，第二次短按暂离，再按返回；
 * 长按释放，暂离时双击延长。按键接 GPIO3 与 GND。
 * USE_OCCUPANCY_SENSOR=1 保留 GPIO6 占位传感器模式。
 * USE_USB_SERIAL=0 后才使用下文的 Wi-Fi 配置和连接方式。
 * 打开 Arduino IDE 串口监视器或上传前，请先退出占用同一 COM 口的桥接。
 *
 * 项目根目录 README.md 提供接线、启动和访客站部署步骤。
 * 本固件在下方镜像 shared/protocol.js v1.0.0 中使用的协议常量。
 *
 * ---------------------------------------------------------------------------
 * 一、系统说明与数据流
 * ---------------------------------------------------------------------------
 * Hub（Node.js）是座位状态与时间的唯一权威。设备只上报「事实」：按键动作、
 * 占位传感器边沿、心跳；Hub 推导权威 status、盖时间戳 awayUntil，再把
 * snapshot / seat.update 广播回设备与所有 Dashboard。设备屏幕上的倒计时，
 * 在线时用「本地接收时刻 + (awayUntil - serverNow)」对齐服务端时钟；
 * 仅在离线期间才用 millis() 自行走时做兜底，重连后被 snapshot 覆盖。
 *
 *   [按键 GPIO3 ] ---+
 *   [占位 GPIO6 ] ---+---> [ ESP32-C3 本固件 ]                             
 *   [OLED  I2C  ] <--+        |  ^                                           
 *   [蜂鸣 GPIO7 ] <--+        |  |  hello / button / sensor / ping           
 *   [WS2812 GP8 ] <--+        |  |                                           
 *                             v  |  snapshot / seat.update / config.update   
 *                         WiFi + WebSocket                 alert / pong / error
 *                                |                                            
 *                                v                                           
 *              ws://HUB:8080/ws?role=device&id=SEAT_A01                      
 *                                |                                            
 *                                v                                           
 *                    [ Node.js Hub (权威) ] ---> [ Dashboard / Admin UI ]     
 *                                ^                                            
 *                                +--- REST /api/* , 静态站点 /               
 *
 *   设备内部： ISR(仅置标志) -> 主循环去抖/短按/长按/双击状态机 -> seq 递增
 *              -> sendJson() -> (在线 sendTXT | 离线 16 条环形队列)
 *              <- webSocketEvent(TEXT) -> ArduinoJson v7 解析 -> 状态镜像/时钟同步
 *              -> drawScreen() 局部重绘 SSD1306 + RGB 状态色 + 非阻塞蜂鸣
 *
 * ---------------------------------------------------------------------------
 * 二、硬件接线表（ESP32-C3 SuperMini / DevKitM-1）
 * ---------------------------------------------------------------------------
 *   功能             宏             GPIO   方向      说明
 *   ---------------  -------------  -----  -------  ---------------------------
 *   按键              BTN_PIN       3      IN_PULLUP 另一端接 GND，按下 = LOW
 *   占位传感器        SENSOR_PIN    6      IN_PULLUP FSR 比较器 / 红外对射 /
 *                                                  压力开关，LOW = 有人(occupied)
 *   无源蜂鸣器        BUZZER_PIN    7      OUT      LEDC 输出 2kHz 方波，需驱动
 *                                                  三极管或直接用有源蜂鸣器改低
 *   OLED SDA          I2C_SDA       4      I2C      SSD1306 128x64，地址 0x3C
 *   OLED SCL          I2C_SCL       5      I2C      建议模块自带 4.7k 上拉
 *   板载 WS2812       RGB_PIN       8      OUT      ENABLE_RGB 0 可完全关闭
 *   OLED VCC/GND      -             -      -        3.3V / GND（勿接 5V 到 SDA）
 *
 *   * strapping 引脚警告：ESP32-C3 的 GPIO2 / GPIO8 / GPIO9 是启动配置
 *     (strapping) 引脚，原生 USB 使用 GPIO18 / GPIO19。本方案的按键、
 *     传感器、蜂鸣器、I2C 已刻意避开 2/9/0/1；只有 GPIO8 因为「板载
 *     WS2812 由硬件焊死」无法改，它在上电采样完成后才由本固件驱动，且默认
 *     可用 ENABLE_RGB 0 关闭，不影响启动。若你的板子 RGB 在别的脚，改宏即可。
 *   * 所有 GPIO 均为 3.3V 逻辑，切勿把 5V 直接怼到输入脚。
 *
 * ---------------------------------------------------------------------------
 * 三、依赖库安装清单（Arduino IDE -> 工具 -> 管理库，或 arduino-cli lib install）
 * ---------------------------------------------------------------------------
 *   Library Manager 搜索名          作者/仓库                      头文件
 *   -----------------------------  ----------------------------  ----------------
 *   WebSockets                     Markus Sattler (Links2004)   <WebSocketsClient.h>
 *   ArduinoJson (v7.x)             Benoit Blanchon               <ArduinoJson.h>
 *   Adafruit GFX Library           Adafruit                      <Adafruit_GFX.h>
 *   Adafruit SSD1306               Adafruit                      <Adafruit_SSD1306.h>
 *   Adafruit NeoPixel              Adafruit                      <Adafruit_NeoPixel.h>
 *   (内置，无需安装)               Arduino-ESP32 core            <WiFi.h> <Wire.h>
 *   (内置，无需安装)               Arduino-ESP32 core            <Preferences.h> (NVS 存 seq)
 *
 *   arduino-cli 示例：
 *     arduino-cli lib install "WebSockets" "ArduinoJson" \
 *       "Adafruit GFX Library" "Adafruit SSD1306" "Adafruit NeoPixel"
 *
 * ---------------------------------------------------------------------------
 * 四、Arduino IDE 开发板配置
 * ---------------------------------------------------------------------------
 *   开发板          : ESP32C3 Dev Module  (esp32:esp32:esp32c3)
 *   USB CDC On Boot : Enabled   <-- SuperMini 走原生 USB，必须开，否则串口无输出
 *   Upload Speed    : 921600
 *   CPU Frequency   : 160MHz (WiFi)
 *   Flash Mode      : DIO      Flash Size : 4MB (32Mb)
 *   Partition Scheme: Default 4MB with spiffs
 *   Core Debug Level: None     (本固件自带 LOG_LEVEL 分级日志)
 *   Port            : 设备管理器里的 "USB/JTAG serial debug unit" 对应 COM 口
 *   串口监视器      : 115200 波特率，换行符任选
 *
 *   Arduino-ESP32 core 2.x / 3.x 均已适配：LEDC 蜂鸣器驱动用
 *   ESP_ARDUINO_VERSION_MAJOR 做条件编译（2.x: ledcSetup/ledcAttachPin/
 *   ledcWrite(channel)，3.x: ledcAttach(pin)/ledcWrite(pin)）。
 *
 * ---------------------------------------------------------------------------
 * 五、首次配置步骤
 * ---------------------------------------------------------------------------
 *   1) 改下面「配置区」的 WIFI_SSID / WIFI_PASS（只支持 2.4GHz）。
 *   2) 查 Hub IP：在跑 Node.js Hub 的机器上 Win 执行 ipconfig、
 *      Linux/Mac 执行 ifconfig / hostname -I，或直接看 Hub 启动日志里的
 *      "listening on ..."。把 WS_HOST 改成这个局域网 IP（不要用 localhost）。
 *   3) 改 SEAT_ID（如 "A01"），必须与 Hub 座位表里的 seatId 完全一致；
 *      SEAT_LABEL 是 OLED 上的显示名；ZONE 是元数据。
 *      固件会自动把 WS_PATH 拼成 /ws?role=device&id=SEAT_<SEAT_ID>。
 *   4) 默认 USE_SSL 0（ws:// + 8080）。若 Hub 挂在 wss 反向代理后面，
 *      改成 USE_SSL 1 且 WS_PORT 443；此时 beginSSL() 不传 CA 证书，库内部
 *      会自动 setInsecure() 跳过自签证书校验（仅演示用，生产见第九节）。
 *   5) 编译上传，打开串口监视器 115200，应能看到第九节前的启动日志。
 *
 * ---------------------------------------------------------------------------
 * 六、协议速查（完整事实源：shared/protocol.js v1.0.0）
 * ---------------------------------------------------------------------------
 *   发 (C2S)：
 *     hello   {type,role:"device",clientId:"SEAT_A01",seatId:"A01",fw,caps}
 *             + 可选 rssi（Hub 扩展：写入 Seat.rssi 供仪表盘显示）
 *     button  {type,seatId,action:away_start|away_cancel|release|extend,seq,ts}
 *     sensor  {type,seatId,occupied:bool,seq}
 *     ping    {type,ts}
 *   收 (S2C)：
 *     snapshot       {type,serverNow,protocol,config,seats:[Seat],alerts:[Alert]}
 *     seat.update    {type,seat:Seat}  (Hub 另注入顶层 serverNow，固件已利用)
 *     config.update  {type,config,serverNow}
 *     alert          {type,alert:Alert}       kind=timeout -> 蜂鸣+红闪
 *     alert.cleared  {type,alertId}            停止告警
 *     pong           {type,ts,serverNow}
 *     error          {type,code,message}
 *   Seat 关键字段：status("available"|"occupied"|"away")、occupied、online、
 *     awayUntil(epoch ms|null)、awayDurationMs、label、ip、rssi、alerting。
 *   Config：awayDurationMin(默认15)、alertLeadSec(60)、graceSec(30)、
 *     heartbeatMs(5000)、offlineAfterMs(15000)、soundEnabled(true)。
 *   状态机（Hub 权威）：占位=有人->occupied；无人->available；
 *     occupied + away_start -> away (awayUntil=now+awayDurationMin*60000)；
 *     away_cancel -> 按占位回 occupied/available；release -> available；
 *     extend -> awayUntil += 5min；now>=awayUntil -> available + timeout 告警。
 *   重连契约：退避 1/2/4/8/16s，上限 30s + jitter；离线缓存最多 16 条按
 *     seq 顺序重放；心跳 5s，2.5 倍(12.5s)无服务端消息强制重连。
 *
 * ---------------------------------------------------------------------------
 * 七、串口监视器预期输出示例（115200）
 * ---------------------------------------------------------------------------
 *   [I] === SmartSeat ESP32-C3 启动 FW=1.0.0 seat=A01 proto=1.0.0 ===
 *   [I] seq 计数器已从 NVS 恢复 = 7
 *   [I] seq 已按 serverNow 对齐到 1730000000
 *   [I] SSD1306 就绪 128x64 @0x3C
 *   [I] 按键中断已挂载 GPIO3 (FALLING)
 *   [I] WiFi 连接中 SSID=MyLab
 *   [I] WiFi UP IP=192.168.1.42 RSSI=-54
 *   [I] WS PLAIN 连接 ws://192.168.1.10:8080/ws?role=device&id=SEAT_A01
 *   [I] WS CONNECTED /ws?role=device&id=SEAT_A01
 *   [D] TX {"type":"hello","role":"device","clientId":"SEAT_A01", ...}
 *   [I] hello 已发送 clientId=SEAT_A01
 *   [D] RX snapshot
 *   [I] 时钟同步 剩余=0 ms
 *   [I] snapshot 已重同步 status=occupied remaining=0 ms
 *   [D] BTN irq @8421
 *   [D] BTN pressed
 *   [D] BTN released
 *   [I] 按键动作 away_start seq=1
 *   [D] TX {"type":"button","seatId":"A01","action":"away_start","seq":1,...}
 *   [D] RX seat.update
 *   [I] 时钟同步 剩余=899000 ms
 *   [I] seat.update -> AWAY remaining=899000 ms
 *   [D] TX {"type":"ping","ts":13480}
 *   [D] RX pong
 *   [W] 12500 ms 无服务端消息
 *   [W] 强制断开重连：12500 ms 无服务端消息
 *   [W] WS DISCONNECTED
 *   [D] QUEUE {"type":"button",...}
 *   [I] 离线队列已按 seq 顺序 flush 1 条
 *   [I] 告警状态 -> OFF
 *
 * ---------------------------------------------------------------------------
 * 八、排错清单
 * ---------------------------------------------------------------------------
 *   OLED 不亮：确认是 0x3C（部分模块 0x3D，改 OLED_ADDR）；SDA/SCL 是否
 *     接反；Wire.begin(4,5) 是否执行；模块是否 3.3V 供电；I2C 是否有上拉；
 *     看串口 "[E] SSD1306 初始化失败"；换一根短线。
 *   WiFi 连不上：ESP32-C3 只支持 2.4GHz；核对 SSID/PASS 大小写；看日志里
 *     "[I] WiFi 尝试连接 step=N 退避=... ms" 是否一直递增；RSSI < -80 时
 *     把 Hub/路由器挪近；确认路由器没开 MAC 过滤。
 *   WS 反复断：核对 WS_HOST 是 Hub 的局域网 IP、WS_PORT=8080、WS_PATH=/ws；
 *     关闭 PC 防火墙；USE_SSL 与端口/协议是否匹配（ws=8080 / wss=443）；
 *     Hub 是否真的回了 pong（否则 12.5s 会被本固件强制重连）；看
 *     "[E] WS ERROR" 与 "[W] 强制断开重连"。
 *   按键误触发：确认 INPUT_PULLUP 且另一端接 GND；下降沿中断 + 35ms 去抖
 *     已在主循环实现，勿在 ISR 里加逻辑；线太长加 100nF 对地电容；
 *     确认 BTN_PIN 与 SENSOR_PIN 没有和 I2C 共用；GPIO3 勿接 5V。
 *   重启后按键/传感器无反应：Hub 的 lastSeq 不随设备重启重置；本固件已用
 *     Preferences(NVS，命名空间 "smartseat" / 键 "seq") 在每次事件发送后写回
 *     计数器、setup 恢复，正常重启不会回退。若换了全新 ESP32（NVS 为空）而
 *     Hub 仍记得旧 lastSeq，把 SEQ_BOOT_BASE 调大或在 Hub 侧重置去重游标。
 *   按键后收到 [E] 服务端 error INVALID_TRANSITION：协议规定 away_start 仅
 *     从 occupied 触发；先把 SENSOR_PIN(6) 拉低 300ms 上报 sensor{true} 再按。
 *   蜂鸣器无声：无源蜂鸣器必须靠方波驱动（本固件用 LEDC 2kHz），直接给
 *     高电平只有"嗒"一声；检查 GPIO7 与三极管/限流电阻；若是"有源"蜂鸣器，
 *     把 BUZZER_FREQ_HZ 调低或直接改 buzzerWrite 为电平驱动。
 *   串口无输出：Arduino IDE 里 USB CDC On Boot 必须 Enabled；波特率 115200；
 *     换一根"数据线"而非纯充电线；按一下板子 RST。
 *   WSS 握手失败：确认 USE_SSL=1 且 WS_PORT=443；本固件默认不传 CA，
 *     库内部会 setInsecure()，因此可连自签证书。若你自行改成
 *     beginSslWithCA()，务必填对根证书 PEM，否则会一直握手失败。
 *     注意 WebSocketsClient 没有公开的 setInsecure() 成员方法，别直接调。
 *   编译时报 ledcSetup 不存在：说明是 core 3.x，确认
 *     esp_arduino_version.h 可被找到；LEDC_CORE3 会自动切到新 API。
 *   同一 SEAT_ID 挂了两块板：Hub 按 seatId 维护单一 lastSeq，序号较小的
 *     那块板事件会被判为重放丢弃。一个座位只能接一台设备。
 *
 * ---------------------------------------------------------------------------
 * 九、生产化建议
 * ---------------------------------------------------------------------------
 *   1) WSS + 正式证书：USE_SSL 1、WS_PORT 443，把 wsConnect() 里的 beginSSL()
 *      换成库真实 API beginSslWithCA(host, port, path, caCertPem) 或
 *      beginSslWithBundle(...)，固定根证书并做轮换；Hub 前挂 Nginx/Caddy 反代。
 *      WebSocketsClient 没有公开的 setInsecure() / setCAcert() 成员方法。
 *   2) Hub 发现：用 mDNS / 静态 IP / 配网页面（WiFiManager、SoftAP）替代
 *      硬编码 WS_HOST；Wi-Fi 凭据写入 NVS 而非源码。
 *   3) OTA：ArduinoOTA 或 HTTPS OTA + 双分区回滚；FW_VERSION 随包递增。
 *   4) 看门狗：esp_task_wdt_add(NULL) 并在 loop 里 esp_task_wdt_reset()；
 *      本固件 loop 无 delay()、单次 I2C 刷新 < 5ms，已对 TWDT 友好。
 *   5) 深睡：仅在 AVAILABLE 且长时间无事件时 esp_deep_sleep_start()，用
 *      GPIO3 作为 ext0 唤醒源；注意醒来后必须重连 + 等 snapshot 重同步，
 *      离线期间倒计时由 Hub 权威继续走（协议明确：away countdown KEEPS
 *      RUNNING while the device is offline）。
 *   6) seq 跨重启单调【已实现】：Hub 的 lastSeq 不随设备重启重置，本固件用
 *      内置 Preferences(NVS，命名空间 "smartseat" / 键 "seq") 在每次
 *      button/sensor 发送后写回计数器、setup 恢复；首次收到 serverNow 时
 *      还会把 seq 抬到「epoch 秒」量级，自动覆盖「换新板但 Hub 记得旧
 *      lastSeq」，SEQ_BOOT_BASE 是额外的手动旋钮。掉电最多丢最后一个序号，
 *      下一帧仍会被 Hub 接受。Hub 侧 lastSeq 只在内存，重启后回到 -1，
 *      不会误丢设备较大的 seq；但同一 SEAT_ID 严禁同时挂两块板。
 *      生产可再考虑写磨损均衡 / 定期 checkpoint 与 lastSeq 持久化。
 *   7) 时间：接 SNTP 后可用真实 epoch 填 button.ts；当前无 RTC，在线时用
 *      「时钟模型估算的 serverNow」，离线用 millis() 兜底。
 *   8) 传感器：FSR 加硬件 RC 滤波 + 校准阈值；长期 occupied 与 away 冲突
 *      8s 由 Hub 判 sensor_conflict 告警。
 * ============================================================================ */

#include <Arduino.h>   // 先拿到 uint32_t / int64_t / String 等基础类型

// ============================================================================
// 协议常量镜像 —— 与 shared/protocol.js v1.0.0 保持同步（唯一事实源）
// ----------------------------------------------------------------------------
// 该文件是 JS 模块，C++ 无法 import，故把本固件用到的常量镜像在下面。
// 升级协议版本号时，必须同时修改 PROTO_VERSION_MIRROR 与 Hub / Dashboard。
// ============================================================================
static constexpr const char* PROTO_VERSION_MIRROR   = "1.0.0";
static constexpr const char* ROLE_DEVICE            = "device";
static constexpr const char* STATUS_AVAILABLE       = "available";
static constexpr const char* STATUS_OCCUPIED        = "occupied";
static constexpr const char* STATUS_AWAY            = "away";
static constexpr const char* ACT_AWAY_START         = "away_start";
static constexpr const char* ACT_AWAY_CANCEL        = "away_cancel";
static constexpr const char* ACT_RELEASE            = "release";
static constexpr const char* ACT_EXTEND             = "extend";
static constexpr const char* MSG_HELLO              = "hello";
static constexpr const char* MSG_BUTTON             = "button";
static constexpr const char* MSG_SENSOR             = "sensor";
static constexpr const char* MSG_STATE              = "state";
static constexpr const char* MSG_PING               = "ping";
static constexpr const char* MSG_SNAPSHOT           = "snapshot";
static constexpr const char* MSG_SEAT_UPDATE        = "seat.update";
static constexpr const char* MSG_CONFIG_UPDATE      = "config.update";
static constexpr const char* MSG_ALERT              = "alert";
static constexpr const char* MSG_ALERT_CLEARED      = "alert.cleared";
static constexpr const char* MSG_PONG               = "pong";
static constexpr const char* MSG_ERROR              = "error";
static constexpr const char* ALERT_TIMEOUT          = "timeout";
static constexpr const char* ALERT_PRE_TIMEOUT      = "pre_timeout";
// DEFAULT_CONFIG
static constexpr uint32_t DEF_AWAY_MS           = 15UL * 60UL * 1000UL;
static constexpr uint32_t DEF_ALERT_LEAD_S      = 60;
static constexpr uint32_t DEF_GRACE_S           = 30;
static constexpr uint32_t DEF_HEARTBEAT_MS      = 5000;
static constexpr uint32_t DEF_OFFLINE_AFTER_MS  = 15000;
static constexpr bool     DEF_SOUND_ENABLED     = true;
// TIMING
static constexpr uint32_t PROTO_TICK_MS          = 250;
static constexpr uint32_t PROTO_EXTEND_MS        = 5UL * 60UL * 1000UL;
static constexpr uint32_t PROTO_BACKOFF_BASE_MS  = 1000;
static constexpr uint32_t PROTO_BACKOFF_MAX_MS   = 30000;
static constexpr uint32_t PROTO_SENSOR_CONFLICT_MS = 8000;
static constexpr uint8_t  PROTO_QUEUE_MAX        = 16;
// ============================================================================

// ============================================================================
// 依赖库
// ============================================================================
// epoch ms (~1.7e12) 需要 64 位整数；ESP32 core 默认已开启，这里显式兜底。
// 注意：Arduino .ino 预处理可能把 #include 提升到本行之前，故解析 epoch 一律
// 走 epochOf() 的 double 通道，不依赖 as<int64_t>()。
#define ARDUINOJSON_USE_LONG_LONG 1
#include <WiFi.h>
#include <Wire.h>
#include <Preferences.h>        // ESP32 内置：NVS 持久化 seq（跨重启单调）
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_NeoPixel.h>   // ENABLE_RGB 0 时仍保留头文件；若未安装该库，把本行一起删除

#if defined(__has_include)
#  if __has_include(<esp_arduino_version.h>)
#    include <esp_arduino_version.h>
#  endif
#endif

// core 3.x 移除了 ledcSetup/ledcAttachPin，改用 ledcAttach(pin)/ledcWrite(pin)
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
#  define LEDC_CORE3 1
#else
#  define LEDC_CORE3 0
#endif

// 关于自签证书：WebSocketsClient 并没有公开的 setInsecure() 方法，但
// ESP32 分支在 beginSSL() 未提供 fingerprint / CA 证书时，库会在 loop() 里
// 对内部的 WiFiClientSecure 调用 setInsecure()，等价于跳过证书校验（演示用）。
// 生产环境请改用 beginSslWithCA() / beginSslWithBundle()，见头部第九节。

// ============================================================================
// 配置区 —— 首次使用只需改这里
// ============================================================================
#ifndef USE_USB_SERIAL
#define USE_USB_SERIAL 1
#endif
#ifndef USE_OCCUPANCY_SENSOR
#define USE_OCCUPANCY_SENSOR 0
#endif
#define WIFI_SSID   "YOUR_WIFI_SSID"
#define WIFI_PASS   "YOUR_WIFI_PASS"
#define WS_HOST     "192.168.1.10"
#define WS_PORT     8080
#define WS_PATH     "/ws"
#define USE_SSL     0
#define SEAT_ID     "A01"
#define SEAT_LABEL  "A-01"
#define ZONE        "Zone A - Window"
#define FW_VERSION  "1.1.0"

#define LOG_LEVEL   3      // 0=静默 1=ERROR 2=+WARN 3=+INFO 4=+DEBUG

// Hub 的 lastSeq 不随设备重启重置，故 seq 必须用 NVS 跨重启持久化。
// 若更换「全新 ESP32 板子」（NVS 为空）而 Hub 仍记得旧 lastSeq，把
// SEQ_BOOT_BASE 调到大于该值，新设备的事件才不会被当成重放丢弃。
#define SEQ_BOOT_BASE   0
#define SEQ_NVS_NS      "smartseat"
#define SEQ_NVS_KEY     "seq"

// ============================================================================
// 引脚表 —— 全部可改
// ============================================================================
#define BTN_PIN      3
#define SENSOR_PIN   6
#define BUZZER_PIN   7
#define I2C_SDA      4
#define I2C_SCL      5
#define RGB_PIN      8
#define OLED_ADDR    0x3C
#define SCREEN_W     128
#define SCREEN_H     64
#define ENABLE_RGB   1

// ============================================================================
// 具名常量（无魔法数）
// ============================================================================
#define OUT_QUEUE_MAX       PROTO_QUEUE_MAX
#define OUT_JSON_MAX        256
#define CLIENT_ID_MAX       24
#define LABEL_MAX           20

static constexpr uint32_t BTN_DEBOUNCE_MS      = 35;
static constexpr uint32_t BTN_LONG_MS          = 1500;
static constexpr uint32_t BTN_DOUBLE_GAP_MS    = 320;
static constexpr uint32_t SENSOR_SAMPLE_MS     = 100;
static constexpr uint8_t  SENSOR_CONSISTENT_N  = 3;
static constexpr uint32_t DISPLAY_REFRESH_MS   = PROTO_TICK_MS;
static constexpr uint32_t STALL_DEFAULT_MS     = 12500;   // 5000 * 2.5
static constexpr uint32_t STALL_MIN_MS         = 5000;
static constexpr uint32_t RGB_REFRESH_MS       = 50;
static constexpr uint32_t RGB_FLASH_MS         = 250;
static constexpr uint32_t RGB_BREATHE_MS       = 2000;
static constexpr uint8_t  SEAT_LED_BRIGHTNESS  = 90;
static constexpr uint8_t  RGB_AMBER_MAX_R      = 150;
static constexpr uint32_t BUZZER_FREQ_HZ       = 2000;
static constexpr uint8_t  BUZZER_LEDC_RES      = 8;
static constexpr uint8_t  BUZZER_LEDC_CH       = 0;
static constexpr uint8_t  BUZZER_DUTY          = 128;   // 8bit 分辨率 -> 50%
static constexpr uint16_t BUZZ_SHORT_MS        = 120;
static constexpr uint16_t BUZZ_GAP_MS          = 90;
static constexpr uint16_t BUZZ_LONG_MS         = 420;
static constexpr uint16_t BUZZ_PAUSE_MS        = 900;
static constexpr int64_t  MAX_AWAY_REMAIN_MS   = 24LL * 3600LL * 1000LL;

// ============================================================================
// 分级日志
// ============================================================================
#if LOG_LEVEL >= 1
#  define LOGE(fmt, ...) Serial.printf("[E] " fmt "\n", ##__VA_ARGS__)
#else
#  define LOGE(fmt, ...)
#endif
#if LOG_LEVEL >= 2
#  define LOGW(fmt, ...) Serial.printf("[W] " fmt "\n", ##__VA_ARGS__)
#else
#  define LOGW(fmt, ...)
#endif
#if LOG_LEVEL >= 3
#  define LOGI(fmt, ...) Serial.printf("[I] " fmt "\n", ##__VA_ARGS__)
#else
#  define LOGI(fmt, ...)
#endif
#if LOG_LEVEL >= 4
#  define LOGD(fmt, ...) Serial.printf("[D] " fmt "\n", ##__VA_ARGS__)
#else
#  define LOGD(fmt, ...)
#endif

// ============================================================================
// 全局对象与状态
// ============================================================================
static WebSocketsClient webSocket;
static Preferences      seqStore;      // NVS：跨重启保存 seq
static Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);
#if ENABLE_RGB
static Adafruit_NeoPixel rgb(1, RGB_PIN, NEO_GRB + NEO_KHZ800);
#endif

enum Status : uint8_t { AVAILABLE, OCCUPIED, AWAY };

static volatile bool     btnIrqFired   = false;
static volatile uint32_t btnIrqMs      = 0;

static char clientIdBuf[CLIENT_ID_MAX] = "SEAT_A01";
static char seatLabelBuf[LABEL_MAX]    = SEAT_LABEL;

// 状态镜像
static Status   status                 = AVAILABLE;
static bool     occupiedFromServer     = false;
static bool     awayActive             = false;
static uint32_t awayUntilLocalMs       = 0;   // 基于 millis 的本地截止时刻
static uint32_t awayDurationMs         = DEF_AWAY_MS;
static bool     localTimeoutFired      = false;
static bool     alertActive            = false;

// 服务端时钟模型：clkServerEpoch 对应本机 clkLocalMs 时刻
static int64_t  clkServerEpoch     = 0;
static uint32_t clkLocalMs         = 0;
static bool     clockSynced        = false;
static int64_t  lastAwayUntilEpoch = 0;   // 最近一次权威 awayUntil(epoch ms)

// Config 镜像
static uint32_t cfgAwayDurationMs   = DEF_AWAY_MS;
static uint32_t cfgAlertLeadSec     = DEF_ALERT_LEAD_S;
static uint32_t cfgGraceSec         = DEF_GRACE_S;
static uint32_t cfgHeartbeatMs      = DEF_HEARTBEAT_MS;
static uint32_t cfgOfflineAfterMs   = DEF_OFFLINE_AFTER_MS;
static bool     cfgSoundEnabled     = DEF_SOUND_ENABLED;
static uint32_t stallMs             = STALL_DEFAULT_MS;

// 网络状态
static bool     wifiConnected       = false;
static bool     wsConnected         = false;
static bool     wsInitialized       = false;
static bool     snapshotReady       = false;
static bool     oledOk              = false;
static bool     sensorReady         = false;
static bool     sensorOccupied      = false;
static bool     sensorPending       = false;
static uint8_t  wifiBackoffStep     = 0;
static uint8_t  wsBackoffStep       = 0;
static uint32_t nextWifiAttemptMs   = 0;
static uint32_t nextWsAttemptMs     = 0;
static uint32_t lastPingMs          = 0;
static uint32_t lastServerMsgMs     = 0;
static uint32_t seqCounter          = 0;
static bool     seqNvsReady         = false;
static bool     seqAlignedToServer  = false;

// 离线环形队列（按入队顺序即 seq 顺序）
static char     outQueue[OUT_QUEUE_MAX][OUT_JSON_MAX];
static uint8_t  qHead  = 0;
static uint8_t  qCount = 0;

// 显示刷新
static uint32_t lastDrawMs   = 0;
static uint32_t lastSig      = 0;
static bool     displayDirty = true;

// 蜂鸣 / RGB
static uint8_t  buzzPhase        = 0;
static uint32_t buzzPhaseStartMs = 0;
static bool     buzzerOn         = false;
static uint8_t  lastR = 255, lastG = 255, lastB = 255;
static uint32_t lastRgbMs = 0;

// ============================================================================
// 函数原型（显式声明，避免 Arduino .ino 自动原型生成带来的顺序问题）
// ============================================================================
void IRAM_ATTR onButtonISR();
static uint32_t nextBackoff(uint8_t step);
static void     noteServerNow(int64_t serverNow);
static void     recalcAwayFromServerNow(int64_t serverNow);
static int64_t  estimatedServerNow();
static void     syncAwayFromServer(int64_t awayUntil, int64_t serverNow);
static int32_t  awayRemainingMs();
static Status   parseStatus(const char* s);
static const char* statusText(Status s);
static int64_t  epochOf(JsonVariantConst v);
static void     applyConfig(JsonVariantConst cfg);
static void     applySeat(JsonVariantConst seat, int64_t serverNow);
static void     setAlert(bool on);
static void     formatMMSS(int32_t ms, char* out, size_t n);
static void     enqueueOutbound(const char* json);
static void     flushQueue();
static void     emitJson(JsonDocument& doc, bool allowQueue);
static void     sendJson(JsonDocument& doc);
static void     sendJsonTransient(JsonDocument& doc);
static void     sendHello();
static void     sendPing();
static void     sendButtonAction(const char* action);
static void     sendSensorEdge(bool occupied);
static void     persistSeq();
static void     bumpSeq();
static void     handleInboundText(uint8_t* payload, size_t length);
static void     webSocketEvent(WStype_t type, uint8_t* payload, size_t length);
static void     wsConnect();
static void     forceWsReconnect(const char* why);
static void     handleWiFi();
static void     handleWsConnectSchedule();
static void     handleHeartbeat();
static void     handleButton();
static void     handleSensor();
#if USE_USB_SERIAL
static void     handleUsbSerial();
#endif
static void     handleAwayTimeout();
static void     buzzerWrite(bool on);
static void     handleBuzzer();
static void     rgbSet(uint8_t r, uint8_t g, uint8_t b);
static void     handleRGB();
static void     drawConnBadge(int16_t x, int16_t y, char c, bool on);
static void     drawCentered(const char* txt, int16_t y, uint8_t size);
static uint32_t displaySignature();
static void     drawScreen();
static void     handleDisplay();

// ============================================================================
// setup / loop —— 整个 loop 无 delay()，全部 millis 状态机，对看门狗友好
// ============================================================================
void setup() {
#if USE_USB_SERIAL
    Serial.setRxBufferSize(4096);
#endif
    Serial.begin(115200);
    delay(200);   // 仅初始化阶段：等待 USB CDC 枚举，此后全程禁止 delay()

    LOGI("=== SmartSeat ESP32-C3 启动 FW=%s seat=%s proto=%s ===",
         FW_VERSION, SEAT_ID, PROTO_VERSION_MIRROR);
    LOGI("元数据 label=%s zone=%s", SEAT_LABEL, ZONE);

    snprintf(clientIdBuf, sizeof(clientIdBuf), "SEAT_%s", SEAT_ID);
    snprintf(seatLabelBuf, sizeof(seatLabelBuf), "%s", SEAT_LABEL);
    randomSeed((unsigned long)micros());

    // seq 跨重启单调：Hub 的 lastSeq 不随设备重启重置，从 0 重来会被全部
    // 当作重放丢弃。用内置 Preferences(NVS) 在每次事件发送后写回计数器。
    seqNvsReady = seqStore.begin(SEQ_NVS_NS, false);
    if (seqNvsReady) {
        uint32_t saved = seqStore.getUInt(SEQ_NVS_KEY, 0U);
        seqCounter = (saved > (uint32_t)SEQ_BOOT_BASE)
                     ? saved : (uint32_t)SEQ_BOOT_BASE;
        seqStore.putUInt(SEQ_NVS_KEY, seqCounter);   // 立即落盘，保证下次重启 >= 本次
        LOGI("seq 计数器已从 NVS 恢复 = %lu", (unsigned long)seqCounter);
    } else {
        seqCounter = (uint32_t)SEQ_BOOT_BASE;
        LOGW("NVS 打开失败，seq 从 %lu 开始；重启后事件可能被 Hub 判为重放",
             (unsigned long)seqCounter);
    }

    // ---- GPIO ----
    pinMode(BTN_PIN, INPUT_PULLUP);
    pinMode(SENSOR_PIN, INPUT_PULLUP);
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);

    // ---- 蜂鸣器 LEDC（core 2.x / 3.x 条件编译）----
#if LEDC_CORE3
    ledcAttach(BUZZER_PIN, BUZZER_FREQ_HZ, BUZZER_LEDC_RES);
    ledcWrite(BUZZER_PIN, 0);
#else
    ledcSetup(BUZZER_LEDC_CH, BUZZER_FREQ_HZ, BUZZER_LEDC_RES);
    ledcAttachPin(BUZZER_PIN, BUZZER_LEDC_CH);
    ledcWrite(BUZZER_LEDC_CH, 0);
#endif
    LOGI("蜂鸣器 LEDC 就绪 GPIO%d %uHz (LEDC_CORE3=%d)",
         BUZZER_PIN, (unsigned)BUZZER_FREQ_HZ, (int)LEDC_CORE3);

#if ENABLE_RGB
    rgb.begin();
    rgb.setBrightness(SEAT_LED_BRIGHTNESS);
    rgb.setPixelColor(0, rgb.Color(0, 0, 0));
    rgb.show();
#endif

    // ---- I2C + SSD1306 ----
    if (Wire.begin(I2C_SDA, I2C_SCL, 400000)) {
        Wire.beginTransmission(OLED_ADDR);
        oledOk = (Wire.endTransmission() == 0) &&
                 display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR, true, false);
    }
    if (!oledOk) {
        LOGI("SSD1306 未启用（地址 0x%02X）", OLED_ADDR);
    } else {
        oledOk = true;
        display.clearDisplay();
        display.setTextWrap(false);
        display.setTextColor(SSD1306_WHITE);
        display.cp437(true);
        drawScreen();
        LOGI("SSD1306 就绪 %dx%d @0x%02X", SCREEN_W, SCREEN_H, OLED_ADDR);
    }

    // ---- 按键外部中断：ISR 只置标志，绝不做 Serial / 延时 / JSON ----
    attachInterrupt(digitalPinToInterrupt(BTN_PIN), onButtonISR, FALLING);
    LOGI("按键中断已挂载 GPIO%d (FALLING)", BTN_PIN);

    // ---- 初始本地兜底状态（等待首个 snapshot 覆盖）----
    status              = AVAILABLE;
    awayActive          = false;
    awayUntilLocalMs    = 0;
    awayDurationMs      = DEF_AWAY_MS;
    cfgAwayDurationMs   = DEF_AWAY_MS;
    cfgHeartbeatMs      = DEF_HEARTBEAT_MS;
    cfgOfflineAfterMs   = DEF_OFFLINE_AFTER_MS;
    cfgSoundEnabled     = DEF_SOUND_ENABLED;
    stallMs             = DEF_HEARTBEAT_MS * 5UL / 2UL;
    alertActive         = false;
    localTimeoutFired   = false;

#if USE_USB_SERIAL
    LOGI("USB 串口模式 115200：等待 Windows 串口桥接");
#else
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    nextWifiAttemptMs = millis() + PROTO_BACKOFF_BASE_MS;
    nextWsAttemptMs   = millis();
    LOGI("WiFi 连接中 SSID=%s", WIFI_SSID);
    LOGI("Hub = %s://%s:%d%s?role=%s&id=%s",
         USE_SSL ? "wss" : "ws", WS_HOST, (int)WS_PORT, WS_PATH,
         ROLE_DEVICE, clientIdBuf);
#endif
}

void loop() {
#if USE_USB_SERIAL
    handleUsbSerial();
#else
    handleWiFi();
    handleWsConnectSchedule();
    if (wsInitialized && wifiConnected) webSocket.loop();
#endif

    handleHeartbeat();
#if USE_OCCUPANCY_SENSOR
    handleSensor();
#endif
    handleButton();
    handleAwayTimeout();
    handleBuzzer();
    handleRGB();
    handleDisplay();

    yield();   // 让出 CPU，喂 RTOS 空闲任务 / TWDT
}

// ============================================================================
// 网络：指数退避、WiFi 状态机、WebSocket 连接与事件
// ============================================================================
static uint32_t nextBackoff(uint8_t step) {
    static const uint32_t stepsMs[] = {
        1000, 2000, 4000, 8000, 16000   // 1/2/4/8/16s
    };
    uint32_t base = (step < 5) ? stepsMs[step] : PROTO_BACKOFF_MAX_MS;
    uint32_t jitter = (uint32_t)random(0L, (long)(base / 4UL + 1UL));  // 0~25% jitter
    uint32_t value = base + jitter;
    return (value > PROTO_BACKOFF_MAX_MS) ? PROTO_BACKOFF_MAX_MS : value;
}

static void handleWiFi() {
    bool up = (WiFi.status() == WL_CONNECTED);

    if (up != wifiConnected) {
        wifiConnected = up;
        displayDirty = true;
        if (up) {
            String ip = WiFi.localIP().toString();
            LOGI("WiFi UP IP=%s RSSI=%d", ip.c_str(), (int)WiFi.RSSI());
            wifiBackoffStep = 0;
            nextWsAttemptMs = millis();          // WiFi 恢复后立即发起 WS
        } else {
            LOGW("WiFi DOWN wl_status=%d", (int)WiFi.status());
            wsConnected = false;                 // 本地先判定离线，进入兜底倒计时
            snapshotReady = false;
            if (wsInitialized) webSocket.disconnect();
            nextWifiAttemptMs = millis() + nextBackoff(wifiBackoffStep);
        }
    }

    if (!wifiConnected) {
        if ((int32_t)(millis() - nextWifiAttemptMs) >= 0) {
            uint32_t bo = nextBackoff(wifiBackoffStep);
            LOGI("WiFi 尝试连接 step=%u 退避=%lu ms",
                 (unsigned)wifiBackoffStep, (unsigned long)bo);
            WiFi.begin(WIFI_SSID, WIFI_PASS);
            wifiBackoffStep = (wifiBackoffStep < 6)
                              ? (uint8_t)(wifiBackoffStep + 1) : 6;
            nextWifiAttemptMs = millis() + bo;
        }
    }
}

static void wsConnect() {
    String path = String(WS_PATH) + "?role=" + ROLE_DEVICE + "&id=" + clientIdBuf;

    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(nextBackoff(wsBackoffStep));  // 库内兜底也遵循退避

#if USE_SSL
    // 自签证书演示：不传 fingerprint / CA，库内部会对 WiFiClientSecure 调用
    // setInsecure() 跳过校验。注意 WebSocketsClient 没有公开的 setInsecure()，
    // 切勿写 webSocket.setInsecure()（会编译失败）。生产改 beginSslWithCA()。
    webSocket.beginSSL(WS_HOST, (uint16_t)WS_PORT, path.c_str());
#else
    webSocket.begin(WS_HOST, (uint16_t)WS_PORT, path.c_str());
#endif

    wsInitialized = true;
    LOGI("WS %s 连接 %s://%s:%d%s",
         USE_SSL ? "SSL" : "PLAIN",
         USE_SSL ? "wss" : "ws", WS_HOST, (int)WS_PORT, path.c_str());
}

static void handleWsConnectSchedule() {
    if (!wifiConnected || wsConnected) return;
    if ((int32_t)(millis() - nextWsAttemptMs) < 0) return;

    uint32_t bo = nextBackoff(wsBackoffStep);
    wsConnect();                     // 重新 begin() 触发一次全新握手
    wsBackoffStep = (wsBackoffStep < 6) ? (uint8_t)(wsBackoffStep + 1) : 6;
    nextWsAttemptMs = millis() + bo;
}

static void forceWsReconnect(const char* why) {
    LOGW("强制断开重连：%s", why);
    wsConnected = false;
    snapshotReady = false;
    lastServerMsgMs = 0;
#if !USE_USB_SERIAL
    if (wsInitialized) webSocket.disconnect();
    wsBackoffStep = (wsBackoffStep < 6) ? (uint8_t)(wsBackoffStep + 1) : 6;
    nextWsAttemptMs = millis() + nextBackoff(wsBackoffStep);
#endif
    displayDirty = true;
}

#if USE_USB_SERIAL
static void handleUsbSerial() {
    static uint8_t line[4096];
    static size_t used = 0;
    static bool overflow = false;
    static uint32_t lastHelloMs = millis() - 1000;

    while (Serial.available()) {
        const int byte = Serial.read();
        if (byte < 0 || byte == '\r') continue;
        if (byte == '\n') {
            if (!overflow && used > 0) {
                line[used] = '\0';
                if (strcmp((const char*)line, "{\"type\":\"serial.reconnect\"}") == 0) {
                    forceWsReconnect("串口桥接重新连接");
                    lastHelloMs = millis() - 1000;
                } else {
                    handleInboundText(line, used);
                }
            }
            used = 0;
            overflow = false;
        } else if (used < sizeof(line) - 1) {
            line[used++] = (uint8_t)byte;
        } else {
            overflow = true;
        }
    }

    if (!snapshotReady && Serial && (uint32_t)(millis() - lastHelloMs) >= 1000) {
        lastHelloMs = millis();
        sendHello();
    }
}
#endif

static void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            wsConnected = false;
            snapshotReady = false;
            displayDirty = true;
            LOGW("WS DISCONNECTED");
            wsBackoffStep = (wsBackoffStep < 6) ? (uint8_t)(wsBackoffStep + 1) : 6;
            nextWsAttemptMs = millis() + nextBackoff(wsBackoffStep);
            break;

        case WStype_CONNECTED:
            wsConnected     = true;
            wsBackoffStep   = 0;
            lastServerMsgMs = millis();
            lastPingMs      = millis();
            displayDirty    = true;
            LOGI("WS CONNECTED %s", (const char*)payload);
            sendHello();
            break;

        case WStype_TEXT:
            handleInboundText(payload, length);
            break;

        case WStype_BIN:
            LOGW("WS 收到 BIN 帧（协议要求 TEXT），已忽略 len=%u", (unsigned)length);
            lastServerMsgMs = millis();
            break;

        case WStype_ERROR:
            LOGE("WS ERROR %s", (const char*)payload);
            break;

        default:
            // WStype_PING / WStype_PONG / 分片帧等：算作「服务端有活动」
            lastServerMsgMs = millis();
            break;
    }
}

// ============================================================================
// 时钟同步与状态镜像
// ----------------------------------------------------------------------------
// 设备无 RTC。在线时用「本地接收时刻 + (awayUntil - serverNow)」把权威 epoch
// 截止时刻折算成 millis 截止时刻；服务端后续只在离线期间由 millis 自行走时，
// 一旦收到 snapshot / seat.update / config.update / pong 即被重新覆盖。
// ============================================================================
static int64_t epochOf(JsonVariantConst v) {
    if (v.isNull()) return 0;
    // ArduinoJson v7 在 ARDUINOJSON_USE_LONG_LONG=1 时用 int64_t 存大整数；
    // as<double>() 对整数/浮点都成立，且 epoch ms(~1.7e12) 远小于 2^53，精确无损。
    return (int64_t)v.as<double>();
}

static Status parseStatus(const char* s) {
    if (s == nullptr) return AVAILABLE;
    if (strcmp(s, STATUS_OCCUPIED) == 0) return OCCUPIED;
    if (strcmp(s, STATUS_AWAY) == 0)      return AWAY;
    return AVAILABLE;
}

static const char* statusText(Status s) {
    switch (s) {
        case OCCUPIED: return "OCCUPIED";
        case AWAY:     return "AWAY";
        default:       return "AVAILABLE";
    }
}

static void noteServerNow(int64_t serverNow) {
    if (serverNow <= 0) return;
    clkServerEpoch = serverNow;   // 该 epoch 对应本机 clkLocalMs 时刻
    clkLocalMs     = millis();
    clockSynced    = true;

    // 首次拿到权威时刻时，把 seq 抬到「epoch 秒」量级：即使换了全新 ESP32
    // （NVS 为空）而 Hub 仍记得该座位旧 lastSeq，新设备的序号也必然更大，
    // 不会被判为重放。只做一次，避免 floor 随真实时间每秒增长而高频写 NVS。
    // 【关键】语义必须是 seq = max(currentSeq, floor)，绝不回退；且
    // seqAlignedToServer 是全局一次性标志，任何 WS 重连路径都不得重置它：
    // 否则设备跑一段时间后短时重连，floor 只比上次多几秒，却可能小于
    // bumpSeq 已推到的 seq，一旦回退，后续帧会被 Hub 判为重放全部丢弃。
    if (!seqAlignedToServer) {
        seqAlignedToServer = true;
        uint32_t floor = (uint32_t)(serverNow / 1000);
        if (seqCounter < floor) {
            seqCounter = floor;      // == max(seqCounter, floor)
            persistSeq();
            LOGI("seq 已按 serverNow 对齐到 %lu", (unsigned long)seqCounter);
        }
    }
}

static int64_t estimatedServerNow() {
    if (!clockSynced) return 0;
    // (uint32_t)(millis() - clkLocalMs) 对 millis 回绕安全
    return clkServerEpoch + (int64_t)(uint32_t)(millis() - clkLocalMs);
}

static int32_t awayRemainingMs() {
    if (!awayActive) return 0;
    int32_t d = (int32_t)(awayUntilLocalMs - millis());   // wrap-safe 差值
    return (d > 0) ? d : 0;
}

static void syncAwayFromServer(int64_t awayUntil, int64_t serverNow) {
    if (serverNow > 0) noteServerNow(serverNow);

    // snapshot/config.update/pong 带 serverNow 时直接取其差值；
    // seat.update 不带顶层 serverNow，则用已建立的时钟模型估算当前服务端时刻。
    int64_t ref = (serverNow > 0) ? serverNow : estimatedServerNow();
    if (ref <= 0) {
        lastAwayUntilEpoch = 0;
        awayActive         = true;
        awayUntilLocalMs   = millis() + awayDurationMs;
        localTimeoutFired  = false;
        LOGW("尚无 serverNow 时钟模型，改用本地兜底时长 %lu ms",
             (unsigned long)awayDurationMs);
        return;
    }

    int64_t remaining = awayUntil - ref;
    if (remaining < 0) remaining = 0;
    if (remaining > MAX_AWAY_REMAIN_MS) remaining = MAX_AWAY_REMAIN_MS;

    lastAwayUntilEpoch = awayUntil;
    awayUntilLocalMs   = millis() + (uint32_t)remaining;
    awayActive         = true;
    localTimeoutFired  = false;
    LOGI("时钟同步 剩余=%lld ms（本地截止 %lu）",
         (long long)remaining, (unsigned long)awayUntilLocalMs);
}

// pong / config.update 只带 serverNow（不带 awayUntil）：用最近一次权威
// awayUntil 按「本地接收时刻 + (awayUntil - serverNow)」重新折算，覆盖本地
// 兜底值，抵消 millis 漂移。离线期间无该消息，倒计时才纯由 millis 自行走时。
static void recalcAwayFromServerNow(int64_t serverNow) {
    if (serverNow <= 0 || !awayActive || lastAwayUntilEpoch <= 0) return;

    int64_t remaining = lastAwayUntilEpoch - serverNow;
    if (remaining < 0) remaining = 0;
    if (remaining > MAX_AWAY_REMAIN_MS) remaining = MAX_AWAY_REMAIN_MS;

    awayUntilLocalMs = millis() + (uint32_t)remaining;
    if (remaining > 0) localTimeoutFired = false;
    LOGD("serverNow 重算 剩余=%lld ms", (long long)remaining);
}

static void applyConfig(JsonVariantConst cfg) {
    if (cfg.isNull()) return;

    float mins = cfg["awayDurationMin"] | 15.0f;
    cfgAwayDurationMs = (mins > 0.0f)
                        ? (uint32_t)(mins * 60000.0f) : DEF_AWAY_MS;
    cfgAlertLeadSec   = cfg["alertLeadSec"]   | DEF_ALERT_LEAD_S;
    cfgGraceSec       = cfg["graceSec"]       | DEF_GRACE_S;
    cfgOfflineAfterMs = cfg["offlineAfterMs"] | DEF_OFFLINE_AFTER_MS;
    cfgSoundEnabled   = cfg["soundEnabled"]   | true;

    uint32_t hb = cfg["heartbeatMs"] | DEF_HEARTBEAT_MS;
    cfgHeartbeatMs = (hb >= 1000UL) ? hb : DEF_HEARTBEAT_MS;
    stallMs = (uint32_t)((uint64_t)cfgHeartbeatMs * 5UL / 2UL);  // 2.5x
    if (stallMs < STALL_MIN_MS) stallMs = STALL_MIN_MS;

    LOGI("config 生效 away=%lu ms lead=%lu s grace=%lu s hb=%lu ms "
         "offlineAfter=%lu ms stall=%lu ms sound=%d",
         (unsigned long)cfgAwayDurationMs, (unsigned long)cfgAlertLeadSec,
         (unsigned long)cfgGraceSec, (unsigned long)cfgHeartbeatMs,
         (unsigned long)cfgOfflineAfterMs, (unsigned long)stallMs,
         (int)cfgSoundEnabled);
}

static void applySeat(JsonVariantConst seat, int64_t serverNow) {
    if (seat.isNull()) return;

    status              = parseStatus(seat["status"] | STATUS_AVAILABLE);
    occupiedFromServer  = seat["occupied"] | false;

    const char* lbl = seat["label"] | "";
    if (lbl[0] != '\0') {
        strncpy(seatLabelBuf, lbl, sizeof(seatLabelBuf) - 1);
        seatLabelBuf[sizeof(seatLabelBuf) - 1] = '\0';
    }

    uint32_t dur = (uint32_t)(seat["awayDurationMs"] | DEF_AWAY_MS);
    awayDurationMs = (dur > 0) ? dur : cfgAwayDurationMs;

    int64_t until = epochOf(seat["awayUntil"]);
    if (status == AWAY) {
        if (until > 0) {
            syncAwayFromServer(until, serverNow);   // 权威值覆盖本地兜底
        } else {
            awayActive        = true;
            awayUntilLocalMs  = millis() + awayDurationMs;
            localTimeoutFired = false;
            LOGW("status=away 但缺 awayUntil，使用本地兜底 %lu ms",
                 (unsigned long)awayDurationMs);
        }
    } else {
        lastAwayUntilEpoch = 0;
        awayActive         = false;
        awayUntilLocalMs   = 0;
        localTimeoutFired  = false;
    }
    displayDirty = true;
    LOGD("seat 镜像 status=%s occupied=%d online=%d awayDuration=%lu ms",
         statusText(status), (int)occupiedFromServer,
         (int)(seat["online"] | false), (unsigned long)awayDurationMs);
}

static void setAlert(bool on) {
    if (alertActive == on) return;
    alertActive   = on;
    displayDirty  = true;
    LOGI("告警状态 -> %s", on ? "ON (红闪 + 蜂鸣)" : "OFF");
    if (!on) {
        buzzPhase        = 0;
        buzzPhaseStartMs = 0;
    }
}

// ============================================================================
// 入站 JSON 解析（ArduinoJson v7）
// ============================================================================
static void handleInboundText(uint8_t* payload, size_t length) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, (const char*)payload, length);
    if (err) {
        LOGE("JSON 解析失败: %s (len=%u)", err.c_str(), (unsigned)length);
        return;
    }

    lastServerMsgMs = millis();
    const char* type = doc["type"] | "";
    LOGD("RX %s", type);

    if (strcmp(type, MSG_SNAPSHOT) == 0) {
        int64_t sn = epochOf(doc["serverNow"]);
        if (sn > 0) noteServerNow(sn);
        applyConfig(doc["config"]);

        JsonArray seats = doc["seats"].as<JsonArray>();
        bool found = false;
        if (!seats.isNull()) {
            for (JsonVariant s : seats) {
                const char* sid = s["seatId"] | "";
                if (strcmp(sid, SEAT_ID) == 0) {
                    applySeat(s, sn);
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            lastAwayUntilEpoch = 0;
            status             = AVAILABLE;
            awayActive         = false;
            awayUntilLocalMs   = 0;
            LOGW("snapshot 中未找到 seatId=%s，按 AVAILABLE 处理", SEAT_ID);
        }

        // 用服务端权威 alerts 重建本地告警态（无未确认 timeout 则静音）
        bool anyTimeout = false;
        JsonArray alerts = doc["alerts"].as<JsonArray>();
        if (!alerts.isNull()) {
            for (JsonVariant a : alerts) {
                const char* sid  = a["seatId"] | "";
                const char* kind = a["kind"]   | "";
                bool acked       = a["acked"]  | false;
                if (strcmp(sid, SEAT_ID) == 0 &&
                    strcmp(kind, ALERT_TIMEOUT) == 0 && !acked) {
                    anyTimeout = true;
                }
            }
        }
        setAlert(anyTimeout);
        localTimeoutFired = anyTimeout;
        displayDirty      = true;
        LOGI("snapshot 已重同步 status=%s remaining=%ld ms",
             statusText(status), (long)awayRemainingMs());

        if (found) {
            wsConnected = true;
            snapshotReady = true;
            lastPingMs = millis();
            flushQueue();
            if (sensorReady && (sensorPending || occupiedFromServer != sensorOccupied)) {
                sendSensorEdge(sensorOccupied);
                sensorPending = false;
            }
        }

    } else if (strcmp(type, MSG_SEAT_UPDATE) == 0) {
        JsonVariantConst s = doc["seat"];
        const char* sid = s["seatId"] | "";
        if (strcmp(sid, SEAT_ID) == 0) {
            // Hub 的 send()/broadcast() 会给每条 S2C 帧注入 serverNow，
            // 因此直接用帧内权威时刻对齐，比仅靠时钟模型估算更精确；
            // 若字段缺失（旧版 Hub），epochOf 返回 0，自动回退到时钟模型。
            applySeat(s, epochOf(doc["serverNow"]));
            LOGI("seat.update -> %s remaining=%ld ms",
                 statusText(status), (long)awayRemainingMs());
        } else {
            LOGD("seat.update 属于 %s，忽略", sid);
        }

    } else if (strcmp(type, MSG_CONFIG_UPDATE) == 0) {
        int64_t sn = epochOf(doc["serverNow"]);
        if (sn > 0) {
            noteServerNow(sn);
            recalcAwayFromServerNow(sn);
        }
        applyConfig(doc["config"]);
        displayDirty = true;
        LOGI("config.update 已应用");

    } else if (strcmp(type, MSG_ALERT) == 0) {
        JsonVariantConst a = doc["alert"];
        const char* sid  = a["seatId"]   | "";
        const char* kind = a["kind"]     | "";
        const char* sev  = a["severity"] | "";
        LOGI("alert seat=%s kind=%s severity=%s", sid, kind, sev);
        if ((sid[0] == '\0' || strcmp(sid, SEAT_ID) == 0) &&
            strcmp(kind, ALERT_TIMEOUT) == 0) {
            setAlert(true);
            localTimeoutFired = true;
        } else if (strcmp(kind, ALERT_PRE_TIMEOUT) == 0) {
            LOGW("即将超时（pre_timeout），OLED 保持倒计时");
        }

    } else if (strcmp(type, MSG_ALERT_CLEARED) == 0) {
        LOGI("alert.cleared %s", doc["alertId"] | "");
        setAlert(false);
        localTimeoutFired = false;
        displayDirty = true;

    } else if (strcmp(type, MSG_PONG) == 0) {
        int64_t sn = epochOf(doc["serverNow"]);
        if (sn > 0) {
            noteServerNow(sn);
            recalcAwayFromServerNow(sn);
        }
        LOGD("pong ts=%lld serverNow=%lld",
             (long long)epochOf(doc["ts"]), (long long)sn);

    } else if (strcmp(type, MSG_ERROR) == 0) {
        LOGE("服务端 error code=%s message=%s",
             doc["code"] | "", doc["message"] | "");

    } else {
        LOGW("未知消息类型: %s", type);
    }
}

// ============================================================================
// 出站 JSON / 离线环形队列 / 心跳
// ============================================================================
static bool writeFrame(const char* text) {
#if USE_USB_SERIAL
    if (!Serial) return false;
    return Serial.println(text) == strlen(text) + 2;
#else
    return webSocket.sendTXT((const uint8_t*)text, strlen(text));
#endif
}

static void emitJson(JsonDocument& doc, bool allowQueue) {
    char buf[OUT_JSON_MAX];
    size_t n = serializeJson(doc, buf, sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) {
        LOGE("JSON 序列化失败或缓冲区溢出 (n=%u)", (unsigned)n);
        return;
    }

    const bool ready = allowQueue ? (snapshotReady && qCount == 0) : true;
    if (ready && writeFrame(buf)) {
        LOGD("TX %s", buf);
    } else if (allowQueue) {
        enqueueOutbound(buf);
        LOGD("QUEUE %s", buf);
    } else {
        LOGD("离线，不排队的消息已丢弃: %s", buf);
    }
}

static void sendJson(JsonDocument& doc) {
    emitJson(doc, true);    // 业务事件：离线入队，重连后按 seq 顺序 flush
}

static void sendJsonTransient(JsonDocument& doc) {
    emitJson(doc, false);   // hello / ping：不占队列
}

static void enqueueOutbound(const char* json) {
    if (qCount >= OUT_QUEUE_MAX) {
        qHead = (uint8_t)((qHead + 1) % OUT_QUEUE_MAX);
        qCount--;
        LOGW("离线队列已满(%u)，丢弃最旧一条", (unsigned)OUT_QUEUE_MAX);
    }
    uint8_t idx = (uint8_t)((qHead + qCount) % OUT_QUEUE_MAX);
    strncpy(outQueue[idx], json, OUT_JSON_MAX - 1);
    outQueue[idx][OUT_JSON_MAX - 1] = '\0';
    qCount++;
    LOGD("离线入队，当前 %u 条", (unsigned)qCount);
}

static void flushQueue() {
    uint8_t sent = 0;
    while (qCount > 0 && snapshotReady && writeFrame(outQueue[qHead])) {
        LOGD("FLUSH %s", outQueue[qHead]);
        qHead = (uint8_t)((qHead + 1) % OUT_QUEUE_MAX);
        qCount--;
        sent++;
    }
    if (sent > 0) {
        LOGI("离线队列已按 seq 顺序 flush %u 条", (unsigned)sent);
    }
}

// seq 必须在每次 button/sensor 事件发送前递增并落盘。Hub 的 lastSeq 不随
// 设备重启重置，若重启后从 0 重来，所有事件都会被判为重放而丢弃。
// NVS 写入只在低频的用户按键 / 传感器稳定边沿发生，磨损可忽略。
static void persistSeq() {
    if (seqNvsReady) seqStore.putUInt(SEQ_NVS_KEY, seqCounter);
}

static void bumpSeq() {
    seqCounter++;
    persistSeq();
}

static void sendHello() {
    JsonDocument doc;
    doc["type"]     = MSG_HELLO;
    doc["role"]     = ROLE_DEVICE;
    doc["clientId"] = clientIdBuf;
    doc["seatId"]   = SEAT_ID;
    doc["fw"]       = FW_VERSION;
    // Hub 可选扩展（server/index.js 的 handleHello 支持）：写入 Seat.rssi，
    // 供 Dashboard 显示信号强度；protocol.js 的 hello 形状未列此字段，属增量。
#if !USE_USB_SERIAL
    doc["rssi"]     = (int)WiFi.RSSI();
#endif
    JsonObject caps = doc["caps"].to<JsonObject>();
    caps["button"]  = true;
    caps["sensor"]  = (USE_OCCUPANCY_SENSOR != 0);
    caps["compactSnapshot"] = true; // 只接收本座位和未确认超时告警
    caps["oled"]    = oledOk;
    caps["rgb"]     = (ENABLE_RGB != 0);
    caps["buzzer"]  = true;
    sendJsonTransient(doc);
    LOGI("hello 已发送 clientId=%s", clientIdBuf);
}

static void sendPing() {
    JsonDocument doc;
    doc["type"] = MSG_PING;
    doc["ts"]   = (uint32_t)millis();
    sendJsonTransient(doc);
}

static void sendButtonAction(const char* action) {
    bumpSeq();
    JsonDocument doc;
    doc["type"]   = MSG_BUTTON;
    doc["seatId"] = SEAT_ID;
    doc["action"] = action;
    doc["seq"]    = seqCounter;
    // 无 RTC：在线用时钟模型估算的 serverNow，离线用 millis 兜底。
    // 用 double 承载 epoch，避免依赖 ArduinoJson 的 long long 开关。
    doc["ts"]     = clockSynced ? (double)estimatedServerNow()
                                : (double)millis();
    sendJson(doc);
    LOGI("按键动作 %s seq=%lu", action, (unsigned long)seqCounter);
    if (strcmp(action, ACT_EXTEND) == 0) {
        LOGD("extend 语义：Hub 将把 awayUntil 延长 %lu ms",
             (unsigned long)PROTO_EXTEND_MS);
    }
}

static void sendSensorEdge(bool occupied) {
    bumpSeq();
    JsonDocument doc;
    doc["type"]     = MSG_SENSOR;
    doc["seatId"]   = SEAT_ID;
    doc["occupied"] = occupied;
    doc["seq"]      = seqCounter;
    sendJson(doc);
    LOGI("占位稳定边沿 occupied=%d seq=%lu",
         (int)occupied, (unsigned long)seqCounter);
}

static void handleHeartbeat() {
    if (!wsConnected) return;
    uint32_t now = millis();

    if (snapshotReady && qCount > 0) flushQueue();
    if ((uint32_t)(now - lastPingMs) >= cfgHeartbeatMs) {
        lastPingMs = now;
        sendPing();
    }

    if (lastServerMsgMs != 0 && (uint32_t)(now - lastServerMsgMs) > stallMs) {
        char why[48];
        snprintf(why, sizeof(why), "%lu ms 无服务端消息", (unsigned long)stallMs);
        forceWsReconnect(why);
    }
}

// ============================================================================
// 按键：ISR 只置标志；主循环做 35ms 去抖 + 短按/长按/双击状态机
//   语义：OCCUPIED 短按 -> away_start；AWAY 短按 -> away_cancel；
//         长按 -> release；双击 -> extend。每次带单调递增 seq。
// ============================================================================
void IRAM_ATTR onButtonISR() {
    btnIrqFired = true;
    btnIrqMs    = millis();
}

static void handleButton() {
    static bool     pressCandidate     = false;
    static uint32_t pressCandidateMs   = 0;
    static bool     btnHeld            = false;
    static uint32_t heldSinceMs        = 0;
    static bool     longFired          = false;
    static bool     pendingSingle      = false;
    static uint32_t lastClickMs        = 0;
    static bool     releaseCandidate   = false;
    static uint32_t releaseCandidateMs = 0;

    uint32_t now;

    // 1) 消费 ISR 标志（临界区极短，ISR 内无 Serial / 延时 / JSON）
    bool irq = false;
    uint32_t irqMs = 0;
    noInterrupts();
    if (btnIrqFired) {
        irq    = true;
        irqMs  = btnIrqMs;
        btnIrqFired = false;
    }
    interrupts();
    now = millis();
    if (irq && !btnHeld) {
        pressCandidate   = true;
        pressCandidateMs = irqMs;
        LOGD("BTN irq @%lu", (unsigned long)irqMs);
    }

    // 2) 下降沿去抖：候选后稳定 35ms 且仍为 LOW 才确认按下
    if (pressCandidate &&
        (uint32_t)(now - pressCandidateMs) >= BTN_DEBOUNCE_MS) {
        pressCandidate = false;
        if (digitalRead(BTN_PIN) == LOW) {
            btnHeld          = true;
            heldSinceMs      = now;
            longFired        = false;
            releaseCandidate = false;
            LOGD("BTN pressed");
        }
    }

    // 3) 按住期间：松开去抖（轮询电平）+ 长按检测
    if (btnHeld) {
        if (digitalRead(BTN_PIN) == HIGH) {
            if (!releaseCandidate) {
                releaseCandidate   = true;
                releaseCandidateMs = now;
            } else if ((uint32_t)(now - releaseCandidateMs) >= BTN_DEBOUNCE_MS) {
                btnHeld          = false;
                releaseCandidate = false;
                LOGD("BTN released");
                if (!longFired) {
                    if (status == AWAY && pendingSingle &&
                        (uint32_t)(now - lastClickMs) <= BTN_DOUBLE_GAP_MS) {
                        pendingSingle = false;
                        sendButtonAction(ACT_EXTEND);        // 双击
                    } else {
                        pendingSingle = true;
                        lastClickMs   = now;
                    }
                } else {
                    pendingSingle = false;   // 长按后的松开不产生单击
                }
            }
        } else {
            releaseCandidate = false;
            if (!longFired && (uint32_t)(now - heldSinceMs) >= BTN_LONG_MS) {
                longFired     = true;
                pendingSingle = false;
                sendButtonAction(ACT_RELEASE);               // 长按
            }
        }
    }

    // 4) 单击提交：等双击窗口超时后按当前镜像状态决定语义
    if (pendingSingle && (uint32_t)(now - lastClickMs) > BTN_DOUBLE_GAP_MS) {
        pendingSingle = false;
        if (status == AWAY) {
            sendButtonAction(ACT_AWAY_CANCEL);
#if !USE_OCCUPANCY_SENSOR
        } else if (status == AVAILABLE) {
            // 按键模式由使用者登记坐下，复用 Hub 已有的占位事实协议。
            sendSensorEdge(true);
#endif
        } else {
            // OCCUPIED 时有效；若当前 AVAILABLE，Hub 会按状态机忽略
            sendButtonAction(ACT_AWAY_START);
        }
    }
}

// ============================================================================
// 占位传感器：每 100ms 采样，连续 3 次一致才认定为稳定边沿
// ============================================================================
static void handleSensor() {
    static uint32_t lastSampleMs = 0;
    static bool     lastRaw      = false;
    static uint8_t  stableCount  = 0;   // 当前连续一致的次数

    if ((uint32_t)(millis() - lastSampleMs) < SENSOR_SAMPLE_MS) return;
    lastSampleMs = millis();

    bool occupied = (digitalRead(SENSOR_PIN) == LOW);   // LOW = 有人(occupied)
    if (occupied == lastRaw) {
        if (stableCount < SENSOR_CONSISTENT_N) stableCount++;
    } else {
        lastRaw     = occupied;
        stableCount = 1;
    }

    if (stableCount < SENSOR_CONSISTENT_N) return;

    if (!sensorReady) {
        sensorReady = true;
        sensorOccupied = occupied;
        sensorPending = !snapshotReady;
        LOGI("占位传感器基线 occupied=%d", (int)occupied);
        if (snapshotReady) sendSensorEdge(occupied);
        return;
    }
    if (sensorOccupied != occupied) {
        sensorOccupied = occupied;
        sendSensorEdge(occupied);
    }
}

// ============================================================================
// 离线兜底：本地倒计时归零时触发告警（在线时由服务端 alert 触发）
// ============================================================================
static void handleAwayTimeout() {
    if (awayActive && !localTimeoutFired && awayRemainingMs() == 0) {
        localTimeoutFired = true;
        LOGW("本地暂离倒计时归零（离线兜底），触发超时告警");
        setAlert(true);
        displayDirty = true;
    }
}

// ============================================================================
// 蜂鸣器：LEDC 硬件方波 + millis 状态机实现「短-短-长」三连音，全程非阻塞
// ============================================================================
static void buzzerWrite(bool on) {
    if (on == buzzerOn) return;
    buzzerOn = on;
#if LEDC_CORE3
    ledcWrite(BUZZER_PIN, on ? BUZZER_DUTY : 0);
#else
    ledcWrite(BUZZER_LEDC_CH, on ? BUZZER_DUTY : 0);
#endif
}

static void handleBuzzer() {
    static const uint16_t phasesMs[] = {
        BUZZ_SHORT_MS, BUZZ_GAP_MS, BUZZ_SHORT_MS,
        BUZZ_GAP_MS,   BUZZ_LONG_MS, BUZZ_PAUSE_MS
    };
    static const bool phaseOn[] = { true, false, true, false, true, false };
    static const uint8_t PHASE_COUNT = 6;
    static bool buzzRunning = false;

    bool want = alertActive && cfgSoundEnabled;
    if (!want) {
        if (buzzerOn) buzzerWrite(false);
        buzzRunning      = false;
        buzzPhase        = 0;
        buzzPhaseStartMs = 0;
        return;
    }

    uint32_t now = millis();
    if (!buzzRunning) {
        buzzRunning      = true;
        buzzPhase        = 0;
        buzzPhaseStartMs = now;
        buzzerWrite(phaseOn[0]);
    }
    if ((uint32_t)(now - buzzPhaseStartMs) >= phasesMs[buzzPhase]) {
        buzzPhaseStartMs = now;
        buzzPhase = (uint8_t)((buzzPhase + 1) % PHASE_COUNT);
        buzzerWrite(phaseOn[buzzPhase]);
    }
}

// ============================================================================
// RGB 状态色：绿=available / 蓝=occupied / 琥珀呼吸=away / 红闪=timeout /
//             暗白=offline。ENABLE_RGB 0 时本段编译为空操作。
// ============================================================================
static void rgbSet(uint8_t r, uint8_t g, uint8_t b) {
#if ENABLE_RGB
    if (r == lastR && g == lastG && b == lastB) return;
    lastR = r; lastG = g; lastB = b;
    rgb.setPixelColor(0, rgb.Color(r, g, b));
    rgb.show();
#else
    (void)r; (void)g; (void)b;
#endif
}

static void handleRGB() {
    uint32_t now = millis();
    if ((uint32_t)(now - lastRgbMs) < RGB_REFRESH_MS) return;
    lastRgbMs = now;

    if (alertActive) {
        bool on = ((now / RGB_FLASH_MS) % 2) == 0;      // 红闪
        rgbSet(on ? 255 : 0, 0, 0);
    } else if (!snapshotReady) {
        rgbSet(24, 24, 24);                             // 离线暗白
    } else if (status == AWAY) {
        uint32_t t    = now % RGB_BREATHE_MS;           // 琥珀色呼吸
        uint32_t half = RGB_BREATHE_MS / 2;
        uint8_t v = (uint8_t)((t < half)
                    ? ((uint32_t)RGB_AMBER_MAX_R * t / half)
                    : ((uint32_t)RGB_AMBER_MAX_R * (RGB_BREATHE_MS - t) / half));
        rgbSet(v, (uint8_t)((uint16_t)v * 3 / 5), 0);
    } else if (status == OCCUPIED) {
        rgbSet(0, 0, 140);                              // 蓝
    } else {
        rgbSet(0, 140, 0);                              // 绿
    }
}

// ============================================================================
// OLED 显示：局部 fillRect 清理 + 一次性 display()，无全屏闪烁
// ============================================================================
static void drawConnBadge(int16_t x, int16_t y, char c, bool on) {
    if (on) {
        display.fillRect(x, y, 10, 9, SSD1306_WHITE);
        display.setTextColor(SSD1306_BLACK);
        display.setCursor(x + 2, y + 1);
        display.print(c);
        display.setTextColor(SSD1306_WHITE);
    } else {
        display.drawRect(x, y, 10, 9, SSD1306_WHITE);
        display.setCursor(x + 2, y + 1);
        display.print(c);
    }
}

static void drawCentered(const char* txt, int16_t y, uint8_t size) {
    int16_t  x1 = 0, y1 = 0;
    uint16_t w = 0, h = 0;
    display.setTextSize(size);
    display.getTextBounds(txt, 0, y, &x1, &y1, &w, &h);
    int16_t x = (SCREEN_W - (int16_t)w) / 2;
    if (x < 0) x = 0;
    display.setCursor(x, y);
    display.print(txt);
}

static void formatMMSS(int32_t ms, char* out, size_t n) {
    uint32_t total = (ms > 0) ? (uint32_t)((ms + 999) / 1000) : 0;  // 向上取整
    uint32_t m = total / 60;
    uint32_t s = total % 60;
    if (m > 99) m = 99;
    snprintf(out, n, "%02u:%02u", (unsigned)m, (unsigned)s);
}

static uint32_t displaySignature() {
    uint32_t sig = (uint32_t)status;
    sig = sig * 131u + (uint32_t)(awayActive ? (awayRemainingMs() / 1000) : 0);
    sig = sig * 131u + (uint32_t)(wifiConnected ? 1 : 0);
    sig = sig * 131u + (uint32_t)(wsConnected  ? 1 : 0);
    sig = sig * 131u + (uint32_t)(alertActive  ? 1 : 0);
#if !USE_USB_SERIAL
    int32_t bucket = ((int32_t)WiFi.RSSI() + 100) / 4;
    if (bucket < 0) bucket = 0;
    sig = sig * 131u + (uint32_t)bucket;
#endif
    sig = sig * 131u + (uint32_t)(awayDurationMs / 1000);
    return sig;
}

static void drawScreen() {
    // ---- 顶栏：座位 label + WiFi(W)/WS(S) 连接小图标 ----
    display.fillRect(0, 0, SCREEN_W, 13, SSD1306_BLACK);
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 2);
    display.print(seatLabelBuf);
#if USE_USB_SERIAL
    drawConnBadge(SCREEN_W - 12, 2, 'U', snapshotReady);
#else
    drawConnBadge(SCREEN_W - 24, 2, 'W', wifiConnected);
    drawConnBadge(SCREEN_W - 12, 2, 'S', snapshotReady);
#endif
    display.drawFastHLine(0, 13, SCREEN_W, SSD1306_WHITE);

    // ---- 主体：居中大号状态文字 / AWAY 时 MM:SS + 进度条 + 百分比 ----
    display.fillRect(0, 15, SCREEN_W, 38, SSD1306_BLACK);
    if (status == AWAY) {
        char cd[12];
        int32_t rem = awayRemainingMs();
        formatMMSS(rem, cd, sizeof(cd));
        drawCentered(cd, 17, 2);
        display.setTextSize(1);
        display.setCursor(0, 47);
        display.print("AWAY");

        uint32_t pct = 0;
        if (awayDurationMs > 0) {
            pct = (uint32_t)((uint64_t)(rem > 0 ? rem : 0) * 100UL /
                             awayDurationMs);
        }
        if (pct > 100) pct = 100;
        display.drawRect(6, 37, 100, 8, SSD1306_WHITE);
        int16_t barW = (int16_t)((94u * pct) / 100u);
        if (barW > 0) display.fillRect(7, 38, barW, 6, SSD1306_WHITE);
        char pctBuf[8];
        snprintf(pctBuf, sizeof(pctBuf), "%u%%", (unsigned)pct);
        display.setCursor(109, 38);
        display.print(pctBuf);
    } else {
        drawCentered(statusText(status), 22, 2);
        display.setTextSize(1);
        display.setCursor(0, 47);
        display.print(occupiedFromServer ? "SENSOR: ON" : "SENSOR: OFF");
    }

    if (alertActive) {
        display.setTextSize(1);
        display.setCursor(72, 47);
        display.print("!TIMEOUT");
        display.drawRect(0, 15, SCREEN_W, 38, SSD1306_WHITE);
    }

    // ---- 底栏：IP 末段 / RSSI / FW / OFFLINE 徽标 ----
    display.fillRect(0, 54, SCREEN_W, 10, SSD1306_BLACK);
    display.drawFastHLine(0, 54, SCREEN_W, SSD1306_WHITE);
    display.setTextSize(1);
    char foot[32];
#if USE_USB_SERIAL
    snprintf(foot, sizeof(foot), "USB %s", FW_VERSION);
#else
    snprintf(foot, sizeof(foot), ".%u %d %s",
             (unsigned)WiFi.localIP()[3], (int)WiFi.RSSI(), FW_VERSION);
#endif
    display.setCursor(0, 56);
    display.print(foot);

    if (!snapshotReady) {
        display.fillRect(SCREEN_W - 46, 55, 46, 9, SSD1306_WHITE);
        display.setTextColor(SSD1306_BLACK);
        display.setCursor(SCREEN_W - 44, 56);
        display.print("OFFLINE");
        display.setTextColor(SSD1306_WHITE);
    } else {
        display.setCursor(SCREEN_W - 40, 56);
        display.print("ONLINE");
    }

    display.display();   // 一次推完整帧；缓冲区未整体清空，故无闪烁
}

static void handleDisplay() {
    if (!oledOk) return;
    uint32_t now = millis();
    uint32_t sig = displaySignature();
    if (displayDirty || sig != lastSig ||
        (uint32_t)(now - lastDrawMs) >= DISPLAY_REFRESH_MS) {
        drawScreen();
        lastSig      = sig;
        lastDrawMs   = now;
        displayDirty = false;
    }
}

// ============================== 文件结束 ======================================
