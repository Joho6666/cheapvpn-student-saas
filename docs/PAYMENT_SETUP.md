# CheapVPN payment setup

Production payments run on Docker / Express. Do not commit secrets. Put them in `.env.production`, Docker secrets, or server environment variables.

## WeChat Native (API v3)

Need:

- WeChat Pay merchant ID (`WECHAT_PAY_MCH_ID`)
- AppID (`WECHAT_PAY_APP_ID`)
- Merchant private key and certificate serial (`WECHAT_PAY_PRIVATE_KEY`, `WECHAT_PAY_CERT_SERIAL_NO`)
- APIv3 key (`WECHAT_PAY_API_V3_KEY`)
- WeChat platform public key and ID (`WECHAT_PAY_PUBLIC_KEY`, `WECHAT_PAY_PUBLIC_KEY_ID`)
- Native / QR payment product enabled
- Public HTTPS notify URL, for example `https://domain.com/api/payments/wechat/notify`

Set `WECHAT_PAY_ENABLED=true` only after those values are real. PEM values may use `\n` in env files.

## Alipay face-to-face / precreate

Need:

- Alipay Open Platform app (`ALIPAY_APP_ID`)
- Application RSA2 private key (`ALIPAY_PRIVATE_KEY`)
- Alipay public key (`ALIPAY_PUBLIC_KEY`)
- Face-to-face / `alipay.trade.precreate` product
- Notify URL `https://domain.com/api/payments/alipay/notify`
- Gateway `https://openapi.alipay.com/gateway.do` or sandbox `https://openapi-sandbox.dl.alipaydev.com/gateway.do`

Optional `ALIPAY_SELLER_ID` is checked when present on notify.

## Modes

- `PAYMENT_MODE=mock` development only
- `PAYMENT_MODE=manual` keep human confirmation
- `PAYMENT_MODE=webhook` generic HMAC
- `PAYMENT_MODE=wechat_alipay` official QR payments
- `PAYMENT_PROVIDER_MODE=mock` returns `cheapvpn://mock-payment/{id}` and allows `/api/payments/:id/mock-success` outside production

Production rejects mock mode and mock success.

## Cloudflare Worker

Worker payment is not the production PSP. Express/SQLite is the source of truth.
