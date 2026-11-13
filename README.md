# 限量紅茶搶購站 — 學生 API 說明

你的任務：寫一支程式，在開賣的那一瞬間自動幫你搶到一罐紅茶。

## 遊戲規則

- 今天有 4 組場次，每組 2 罐，共 8 罐。開賣時間依老師公布（也可能由老師現場直接開放）。
- 同一時間只會有一組在販售。
- **每人限購 1 罐**。搶到過的帳號就不能再搶。
- 下一場開始時，上一場就結束了。
- 只接受**貨到付款**，紅茶 10 元。
- 同一個帳號 **1 秒內只能送 1 次購買請求**，送太快會被擋（`RATE_LIMITED`）。
- 開賣時間以**伺服器時間**為準，不是你電腦的時間。

## API 位址

```
API_URL = （老師會公布）
```

所有請求都用 **POST**，body 是 JSON 文字，必須帶 `action`。

> 小提示：Google Apps Script 會先回 302 轉址，你的程式要跟著轉址走。Python 的 `requests` 預設就會跟著轉址。

## 回應格式

成功：

```json
{ "ok": true, "serverTime": 1795150800000, ... }
```

失敗：

```json
{ "ok": false, "code": "SOLD_OUT", "message": "本場已售完", "serverTime": 1795150800000 }
```

`serverTime` 是伺服器的時間（毫秒）。你可以用它來校正自己電腦的時間差。

## 1. 註冊 `register`

```json
{ "action": "register", "username": "stu01", "password": "abcd", "email": "stu01@example.com", "name": "王小明", "address": "新北市某某路 1 號" }
```

- 帳號：3～20 個英文字母、數字或底線
- 密碼：4～30 字元
- Email：只檢查格式
- 姓名、地址：必填，購買時會當作收件資料

## 2. 登入 `login`

```json
{ "action": "login", "username": "stu01", "password": "abcd" }
```

回傳 `token`，6 小時內有效。購買和查訂單都要帶它。

## 3. 查狀態 `status`

```json
{ "action": "status" }
```

回傳所有場次的 `startMs`（開賣時間，毫秒）、`remaining`（剩餘數量），以及 `currentRound`、`nextRound`。

## 4. 購買 `buy`

```json
{ "action": "buy", "token": "登入拿到的 token", "password": "abcd" }
```

- `password`：購買時要再確認一次密碼
- 每人 1 罐、貨到付款，收件人和地址自動使用註冊時填的資料

成功時會回傳訂單資訊，其中 `msAfterOpen` 是「開賣後第幾毫秒搶到」。

## 5. 我的訂單 `myOrders`

```json
{ "action": "myOrders", "token": "..." }
```

## 6. 搶購結果 `results`

```json
{ "action": "results" }
```

## 錯誤代碼

| code | 意思 | 你的程式該怎麼辦？ |
|---|---|---|
| `NOT_STARTED` | 還沒開賣 | 等一下再送 |
| `SOLD_OUT` | 本場賣完了 | 等下一場（看 `nextRound`） |
| `PAUSED` | 老師暫停販售 | 等老師重新開放 |
| `ALREADY_BOUGHT` | 你已經搶到過了 | 停止程式 |
| `RATE_LIMITED` | 送太快 | 間隔 1 秒以上 |
| `BUSY` | 太多人同時搶，伺服器忙 | 馬上再試一次 |
| `WRONG_PASSWORD` | 確認密碼錯誤 | 檢查密碼 |
| `INVALID_TOKEN` | 沒登入或登入過期 | 重新 `login` |
| `BAD_USERNAME` / `BAD_PASSWORD` / `BAD_EMAIL` / `BAD_NAME` / `BAD_ADDRESS` | 註冊資料格式錯誤 | 修正參數 |

## 思考題

1. 每一次請求要花 0.5～2 秒才會回來。你應該在開賣「前」多久送出？
2. 你電腦的時間跟伺服器差多少？怎麼用 `serverTime` 量出來？
3. 送太快會被 `RATE_LIMITED` 擋住，那第一槍該什麼時候開？
4. 開啟網頁按 F12 → Network，看看按下「確認購買」時送出了什麼？
