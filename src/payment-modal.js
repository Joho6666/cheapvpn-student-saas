export function paymentModalHtml({ order, payment, planName, links }) {
  const amount = Number(payment?.amount || order?.amount || 0).toFixed(2);
  const status = payment?.status || "pending";
  const waiting = status === "pending";
  const activating = status === "paid" || status === "activating";
  const active = status === "active";
  const expired = status === "expired";
  const failed = status === "failed";
  return `
    <div class="payment-modal-backdrop" id="payment-modal">
      <div class="payment-modal panel">
        <div class="payment-modal-head">
          <div>
            <div class="text-xs font-bold text-slate-500 uppercase">CheapVPN Student</div>
            <h3 class="text-2xl font-bold mt-1">${escapeText(planName || "Student Plan")}</h3>
            <p class="text-slate-600 mt-1">¥${amount}</p>
          </div>
          <button class="btn btn-secondary" type="button" data-close-payment-modal>关闭</button>
        </div>
        <div class="payment-provider-row">
          <button class="btn ${payment?.provider === "wechat" ? "btn-primary" : "btn-secondary"}" type="button" data-pay-provider="wechat">微信支付</button>
          <button class="btn ${payment?.provider === "alipay" ? "btn-primary" : "btn-secondary"}" type="button" data-pay-provider="alipay">支付宝</button>
        </div>
        <div class="payment-qr-wrap">
          <canvas id="payment-qr-canvas" width="240" height="240"></canvas>
          <p class="text-sm text-slate-500 mt-3">请使用微信/支付宝扫码。若正在手机上浏览，请使用另一台设备扫码。</p>
        </div>
        <div class="payment-status-line">
          ${waiting ? "○ 等待扫码支付" : ""}
          ${activating ? "✓ 支付成功，正在开通服务..." : ""}
          ${active ? "✓ 支付成功<br>✓ CheapVPN 已开通" : ""}
          ${expired ? "二维码已过期" : ""}
          ${failed ? "已收款，开通尚未完成，请稍后刷新或联系管理员" : ""}
        </div>
        ${expired ? `<button class="btn btn-primary mt-4" type="button" data-pay-provider="${escapeText(payment?.provider || "wechat")}">重新生成二维码</button>` : ""}
        ${active ? `<div class="payment-success-actions">
          <button class="btn btn-primary" type="button" data-copy-sub="${escapeText(links?.universal || "")}">复制订阅</button>
          <a class="btn btn-secondary" href="${escapeText(links?.universal || "#")}">Shadowrocket</a>
          <a class="btn btn-secondary" href="${escapeText(links?.clash || "#")}">Clash</a>
          <a class="btn btn-secondary" href="${escapeText(links?.singbox || "#")}">SingBox</a>
        </div>` : ""}
      </div>
    </div>
  `;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

export function paymentPollDelay(hidden) {
  return hidden ? 15000 : 4000;
}

export async function drawPaymentQr(QRCode, canvas, content) {
  if (!canvas || !content) return;
  await QRCode.toCanvas(canvas, content, { width: 240, margin: 2, errorCorrectionLevel: "M", color: { dark: "#17323c", light: "#ffffff" } });
}
