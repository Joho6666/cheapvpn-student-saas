# Payment production checklist

- [ ] WeChat merchant Native pay configured
- [ ] Alipay face-to-face / precreate configured
- [ ] HTTPS on the public domain
- [ ] WeChat and Alipay notify URLs reachable from the public internet
- [ ] Secrets only in environment / Docker secrets, never Git
- [ ] `/health/ready` is 200 and `payment_provider_not_ready` is not blocking
- [ ] WeChat ¥0.01 live test
- [ ] Alipay ¥0.01 live test
- [ ] Duplicate webhook does not double-activate
- [ ] Amount mismatch is rejected
- [ ] Successful scan auto-activates CheapVPN
- [ ] Paid-but-not-activated orders retry or can be retried in admin
- [ ] Database backups exist
- [ ] Logs do not contain private keys, APIv3 keys, or full subscription URLs
- [ ] Refund policy documented (UI refund is not enabled in this version)
- [ ] Payment failure / expired QR recovery understood
