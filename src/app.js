import QRCode from "qrcode";

const state = {
  view: "overview",
  lang: localStorage.getItem("cheapvpn_lang") || "zh",
  user: null,
  plan: null,
  usage: null,
  usageHistory: [],
  subscription: null,
  referral: null,
  plans: [],
  orders: [],
  orderQuery: "",
  orderStatus: "",
  orderPage: 1,
  orderPagination: null,
  tickets: [],
  paymentMode: "mock",
  paymentConfig: null,
  selectedPaymentMethod: "",
  demoEnabled: false,
  authToken: localStorage.getItem("cheapvpn_session"),
  loading: true,
  apiError: "",
};

const adminState = {
  view: "overview",
  token: localStorage.getItem("cheapvpn_admin_session"),
  loading: true,
  error: "",
  metrics: null,
  users: [],
  userQuery: "",
  userPage: 1,
  userPagination: null,
  orders: [],
  tickets: [],
  sources: [],
  upstream: null,
  system: null,
  paymentSettings: null,
  emailSettings: null,
  usageSettings: null,
};

const API_BASE = `${window.location.origin}/api`;
let orderPollTimer = null;
let remoteRefreshTimer = null;
let remoteRefreshInFlight = false;
let buyInFlight = false;
const referralFromUrl = new URLSearchParams(window.location.search).get("ref");
if (referralFromUrl) localStorage.setItem("cheapvpn_referral_code", referralFromUrl.trim().toUpperCase());
const isAdminRoute = () => window.location.hash === "#admin";

const i18n = {
  zh: {
    brandSub: "留学生订阅控制台",
    overview: "总览",
    subscription: "订阅",
    setup: "教程",
    pricing: "套餐",
    billing: "账单",
    referrals: "邀请",
    support: "支持",
    account: "账户",
    welcome: "欢迎回来",
    active: "已生效",
    expired: "已到期",
    inactive: "未开通",
    planStatus: "订阅状态",
    remaining: "剩余流量",
    usedThisCycle: "本周期已用",
    aggregateUsageWarning: "当前用量来自共享上游汇总，不代表本账户的精确独立流量；如需精确统计，请配置供应商客户级用量 API。",
    expires: "到期时间",
    devices: "设备数",
    renewal: "续费价格",
    firstMonth: "新人首月",
    copySubscription: "复制订阅",
    showQr: "显示二维码",
    resetSubscription: "重置订阅",
    syncSubscription: "更新订阅",
    dashboardNote: "现在这版前端更接近你描述的产品：CheapVPN 管理账号、套餐和订阅体验，用户只看到清晰的订阅服务。",
    serviceCardTitle: "订阅服务",
    serviceCardText: "订阅链接由 CheapVPN 统一生成和管理。用户无需理解协议参数，只需要复制链接或扫描二维码导入兼容客户端。",
    formatTitle: "订阅链接",
    formatHelp: "默认展示普通用户能理解的格式，高级格式放在折叠区，减少售后压力。",
    universal: "通用订阅",
    clash: "Clash 订阅",
    singbox: "SingBox 订阅",
    qrTitle: "二维码导入",
    setupTitle: "选择设备并导入订阅",
    setupText: "第一版先使用兼容客户端完成验证，后续再考虑 CheapVPN 自有 App。Apple 设备推荐使用 Shadowrocket。",
    pricingTitle: "学生套餐",
    pricingText: "先保持一个主套餐，所有页面价格一致，避免前端和后台规则打架。",
    referralTitle: "邀请好友",
    referralText: "好友完成首次正式付款后，你获得一次下次续费九折优惠。",
    supportTitle: "帮助支持",
    supportText: "提交问题时请选择设备和客户端，客服可以更快判断是网络、订阅还是客户端配置问题。",
    copied: "订阅链接已复制",
    synced: "订阅已更新",
    reset: "订阅已重置，旧链接将失效",
    primaryPlan: "主套餐",
    mostPopular: "推荐",
    choosePlan: "选择套餐",
    orderHistory: "订单与账单",
    orderHistoryText: "查看开通和续费记录，金额与优惠均来自服务端订单。",
    orderTypeNew: "首次开通",
    orderTypeRenewal: "续费",
    paid: "已支付",
    pending: "待处理",
    discount: "优惠",
    referralReward: "下次续费 9 折",
    referralCondition: "好友首次正式付款后生效",
    signIn: "登录 CheapVPN",
    signUp: "注册账号",
    email: "邮箱",
    password: "密码",
    name: "姓名",
    referralCode: "邀请码（可选）",
    signInAction: "登录",
    signUpAction: "创建账号",
    forgotPassword: "忘记密码？",
    resetPassword: "重置密码",
    resetPasswordTitle: "设置新密码",
    resetPasswordSent: "如果该邮箱已注册，重置链接将发送至邮箱。",
    resetPasswordDone: "密码已重置，请返回登录。",
    useDemo: "使用演示账号",
    demoHint: "演示账号：demo@cheapvpn.local / demo1234",
    signOut: "退出登录",
    accountTitle: "账户设置",
    accountText: "管理登录安全和当前账户信息。修改密码后，其他设备会自动退出。",
    currentPassword: "当前密码",
    newPassword: "新密码",
    confirmPassword: "确认新密码",
    changePassword: "修改密码",
    passwordChanged: "密码已修改，其他设备已退出",
    revokeOtherSessions: "退出其他设备",
    sessionsRevoked: "其他设备已退出",
    profileTitle: "个人资料",
    saveProfile: "保存资料",
    profileSaved: "个人资料已保存",
    apiUnavailable: "暂时无法连接服务，请确认后端已启动。",
    buyPlan: "开通套餐",
    renewPlan: "续费当前周期",
    noSubscription: "当前还没有有效订阅",
    expiredSubscription: "订阅已到期，请重新开通套餐",
    orderCreated: "订单已创建，订阅已开通",
    orderPending: "订单已创建，等待支付确认",
    paymentConfirmed: "支付已确认，订阅已生效",
    paymentFailed: "支付未完成，请重新下单",
    createOrder: "创建订单",
    renewalCreated: "续费成功，订阅有效期已延长一个周期",
  },
  en: {
    brandSub: "Student subscription console",
    overview: "Overview",
    subscription: "Subscription",
    setup: "Setup",
    pricing: "Pricing",
    billing: "Billing",
    referrals: "Referrals",
    support: "Support",
    account: "Account",
    welcome: "Welcome back",
    active: "Active",
    expired: "Expired",
    inactive: "Not active",
    planStatus: "Subscription status",
    remaining: "Data remaining",
    usedThisCycle: "Used this cycle",
    aggregateUsageWarning: "This is shared upstream usage, not precise per-account traffic. Configure a provider per-customer usage API for exact accounting.",
    expires: "Expires",
    devices: "Devices",
    renewal: "Renewal",
    firstMonth: "First month",
    copySubscription: "Copy subscription",
    showQr: "Show QR",
    resetSubscription: "Reset subscription",
    syncSubscription: "Update subscription",
    dashboardNote: "CheapVPN owns the account, plan and subscription experience. Students only see a clean subscription service.",
    serviceCardTitle: "Subscription service",
    serviceCardText: "CheapVPN generates and manages the subscription link. Students do not need to understand protocol settings.",
    formatTitle: "Subscription links",
    formatHelp: "Simple formats are shown first. Advanced options stay tucked away to reduce support work.",
    universal: "Universal",
    clash: "Clash",
    singbox: "SingBox",
    qrTitle: "QR import",
    setupTitle: "Choose your device and import the subscription",
    setupText: "The first release uses compatible clients. For Apple devices, Shadowrocket is recommended.",
    pricingTitle: "Student plan",
    pricingText: "One main plan keeps the dashboard, checkout and renewal rules consistent.",
    referralTitle: "Invite friends",
    referralText: "After your friend completes the first paid month, you get 10% off your next renewal.",
    supportTitle: "Help and support",
    supportText: "Choose your device and client so support can quickly locate the problem.",
    copied: "Subscription copied",
    synced: "Subscription updated",
    reset: "Subscription reset. The old link will stop working.",
    primaryPlan: "Main plan",
    mostPopular: "Recommended",
    choosePlan: "Choose plan",
    orderHistory: "Orders and billing",
    orderHistoryText: "Review activations and renewals. Amounts and discounts come from server-side orders.",
    orderTypeNew: "New activation",
    orderTypeRenewal: "Renewal",
    paid: "Paid",
    pending: "Pending",
    discount: "Discount",
    referralReward: "10% off renewal",
    referralCondition: "Active after friend's first paid month",
    signIn: "Sign in to CheapVPN",
    signUp: "Create an account",
    email: "Email",
    password: "Password",
    name: "Name",
    referralCode: "Referral code (optional)",
    signInAction: "Sign in",
    signUpAction: "Create account",
    forgotPassword: "Forgot password?",
    resetPassword: "Reset password",
    resetPasswordTitle: "Set a new password",
    resetPasswordSent: "If the email is registered, a reset link will be sent.",
    resetPasswordDone: "Password reset. Please return to sign in.",
    useDemo: "Use demo account",
    demoHint: "Demo: demo@cheapvpn.local / demo1234",
    signOut: "Sign out",
    accountTitle: "Account settings",
    accountText: "Manage account security. Other devices will be signed out after a password change.",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    changePassword: "Change password",
    passwordChanged: "Password changed. Other devices were signed out.",
    revokeOtherSessions: "Sign out other devices",
    sessionsRevoked: "Other devices were signed out.",
    profileTitle: "Profile",
    saveProfile: "Save profile",
    profileSaved: "Profile saved",
    apiUnavailable: "The service is unavailable. Please start the backend.",
    buyPlan: "Activate plan",
    renewPlan: "Renew current period",
    noSubscription: "No active subscription yet",
    expiredSubscription: "Subscription expired. Please activate a plan again.",
    orderCreated: "Order confirmed and subscription activated",
    orderPending: "Order created. Waiting for payment confirmation.",
    paymentConfirmed: "Payment confirmed. Your subscription is active.",
    paymentFailed: "Payment was not completed. Please create a new order.",
    createOrder: "Create order",
    renewalCreated: "Renewal confirmed and expiry extended by one billing period",
  },
};

// Keep the original language choices available while using English as a safe
// fallback for newly added operational labels.
i18n.ar = {
  ...i18n.en,
  brandSub: "لوحة اشتراك الطلاب", overview: "نظرة عامة", subscription: "الاشتراك", setup: "الإعداد",
  pricing: "الباقات", billing: "الفواتير", referrals: "الإحالات", support: "الدعم", account: "الحساب",
  welcome: "مرحباً بعودتك", active: "نشط", expired: "منتهٍ", inactive: "غير مشترك",
  planStatus: "حالة الاشتراك", remaining: "البيانات المتبقية", usedThisCycle: "المستخدم في الدورة",
  expires: "ينتهي في", devices: "الأجهزة", renewal: "سعر التجديد", firstMonth: "الشهر الأول",
  copySubscription: "نسخ الاشتراك", showQr: "عرض QR", resetSubscription: "إعادة ضبط الاشتراك", syncSubscription: "تحديث الاشتراك",
  serviceCardTitle: "خدمة الاشتراك", formatTitle: "روابط الاشتراك", universal: "عام", clash: "Clash", singbox: "SingBox",
  qrTitle: "الاستيراد عبر QR", setupTitle: "اختر جهازك واستورد الاشتراك", pricingTitle: "باقة الطلاب",
  referralTitle: "ادعُ أصدقاءك", supportTitle: "المساعدة والدعم", copied: "تم نسخ الاشتراك", synced: "تم تحديث الاشتراك",
  reset: "تمت إعادة ضبط الاشتراك. الرابط القديم متوقف.", mostPopular: "موصى بها", choosePlan: "اختر الباقة",
  orderHistory: "الطلبات والفواتير", orderTypeNew: "تفعيل جديد", orderTypeRenewal: "تجديد", paid: "مدفوع", pending: "قيد الانتظار",
  signIn: "تسجيل الدخول إلى CheapVPN", signUp: "إنشاء حساب", email: "البريد الإلكتروني", password: "كلمة المرور", name: "الاسم",
  referralCode: "رمز الإحالة (اختياري)", signInAction: "دخول", signUpAction: "إنشاء الحساب", useDemo: "استخدام الحساب التجريبي",
  signOut: "تسجيل الخروج", accountTitle: "إعدادات الحساب", currentPassword: "كلمة المرور الحالية", newPassword: "كلمة المرور الجديدة",
  confirmPassword: "تأكيد كلمة المرور الجديدة", changePassword: "تغيير كلمة المرور", saveProfile: "حفظ الملف الشخصي",
  profileSaved: "تم حفظ الملف الشخصي", buyPlan: "تفعيل الباقة", renewPlan: "تجديد الدورة الحالية", noSubscription: "لا يوجد اشتراك نشط",
  expiredSubscription: "انتهى الاشتراك. يرجى تفعيل باقة جديدة", createOrder: "إنشاء طلب",
};
i18n.fr = {
  ...i18n.en,
  brandSub: "Console d'abonnement étudiant", overview: "Aperçu", subscription: "Abonnement", setup: "Configuration",
  pricing: "Forfaits", billing: "Facturation", referrals: "Parrainage", support: "Assistance", account: "Compte",
  welcome: "Bon retour", active: "Actif", expired: "Expiré", inactive: "Non activé", planStatus: "État de l'abonnement",
  remaining: "Données restantes", usedThisCycle: "Utilisé ce cycle", expires: "Expire le", devices: "Appareils",
  renewal: "Renouvellement", firstMonth: "Premier mois", copySubscription: "Copier l'abonnement", showQr: "Afficher le QR",
  resetSubscription: "Réinitialiser", syncSubscription: "Mettre à jour", serviceCardTitle: "Service d'abonnement",
  formatTitle: "Liens d'abonnement", universal: "Universel", clash: "Clash", singbox: "SingBox", qrTitle: "Import QR",
  setupTitle: "Choisissez votre appareil et importez l'abonnement", pricingTitle: "Forfait étudiant", referralTitle: "Inviter des amis",
  supportTitle: "Aide et assistance", copied: "Abonnement copié", synced: "Abonnement mis à jour", reset: "Abonnement réinitialisé. L'ancien lien est désactivé.",
  mostPopular: "Recommandé", choosePlan: "Choisir le forfait", orderHistory: "Commandes et facturation", orderTypeNew: "Nouvelle activation",
  orderTypeRenewal: "Renouvellement", paid: "Payé", pending: "En attente", signIn: "Se connecter à CheapVPN", signUp: "Créer un compte",
  email: "E-mail", password: "Mot de passe", name: "Nom", referralCode: "Code de parrainage (facultatif)", signInAction: "Se connecter",
  signUpAction: "Créer le compte", useDemo: "Utiliser le compte démo", signOut: "Se déconnecter", accountTitle: "Paramètres du compte",
  currentPassword: "Mot de passe actuel", newPassword: "Nouveau mot de passe", confirmPassword: "Confirmer le nouveau mot de passe",
  changePassword: "Modifier le mot de passe", saveProfile: "Enregistrer le profil", profileSaved: "Profil enregistré",
  buyPlan: "Activer le forfait", renewPlan: "Renouveler la période", noSubscription: "Aucun abonnement actif", expiredSubscription: "Abonnement expiré. Activez un forfait pour continuer",
  createOrder: "Créer une commande",
};

const regionalTranslations = {
  th: { brandSub: "คอนโซลสมาชิกนักเรียน", overview: "ภาพรวม", subscription: "สมาชิก", setup: "วิธีตั้งค่า", pricing: "แพ็กเกจ", billing: "คำสั่งซื้อ", referrals: "แนะนำเพื่อน", support: "ช่วยเหลือ", account: "บัญชี", welcome: "ยินดีต้อนรับกลับ", active: "ใช้งานอยู่", expired: "หมดอายุ", inactive: "ยังไม่เปิดใช้", remaining: "ข้อมูลคงเหลือ", copySubscription: "คัดลอกลิงก์", syncSubscription: "อัปเดตสมาชิก", signIn: "เข้าสู่ CheapVPN", signUp: "สร้างบัญชี", email: "อีเมล", password: "รหัสผ่าน", name: "ชื่อ", signInAction: "เข้าสู่ระบบ", signUpAction: "สร้างบัญชี", signOut: "ออกจากระบบ", buyPlan: "เปิดใช้แพ็กเกจ", renewPlan: "ต่ออายุแพ็กเกจ", forgotPassword: "ลืมรหัสผ่าน?" },
  km: { brandSub: "ផ្ទាំងគ្រប់គ្រងសិស្ស", overview: "ទិដ្ឋភាពទូទៅ", subscription: "ការជាវ", setup: "ការណែនាំ", pricing: "កញ្ចប់", billing: "ការបញ្ជាទិញ", referrals: "អញ្ជើញមិត្ត", support: "ជំនួយ", account: "គណនី", welcome: "សូមស្វាគមន៍មកវិញ", active: "កំពុងដំណើរការ", expired: "ផុតកំណត់", inactive: "មិនទាន់បើក", remaining: "ទិន្នន័យនៅសល់", copySubscription: "ចម្លងតំណ", syncSubscription: "ធ្វើបច្ចុប្បន្នភាព", signIn: "ចូល CheapVPN", signUp: "បង្កើតគណនី", email: "អ៊ីមែល", password: "ពាក្យសម្ងាត់", name: "ឈ្មោះ", signInAction: "ចូល", signUpAction: "បង្កើតគណនី", signOut: "ចាកចេញ", buyPlan: "បើកកញ្ចប់", renewPlan: "បន្តកញ្ចប់", forgotPassword: "ភ្លេចពាក្យសម្ងាត់?" },
  lo: { brandSub: "ລະບົບສະມາຊິກນັກຮຽນ", overview: "ພາບລວມ", subscription: "ສະມາຊິກ", setup: "ຄູ່ມື", pricing: "ແພັກເກດ", billing: "ຄໍາສັ່ງຊື້", referrals: "ເຊີນໝູ່", support: "ຊ່ວຍເຫຼືອ", account: "ບັນຊີ", welcome: "ຍິນດີຕ້ອນຮັບກັບ", active: "ກໍາລັງໃຊ້", expired: "ໝົດອາຍຸ", inactive: "ຍັງບໍ່ເປີດ", remaining: "ຂໍ້ມູນຄົງເຫຼືອ", copySubscription: "ສໍາເນົາລິ້ງ", syncSubscription: "ອັບເດດ", signIn: "ເຂົ້າ CheapVPN", signUp: "ສ້າງບັນຊີ", email: "ອີເມວ", password: "ລະຫັດຜ່ານ", name: "ຊື່", signInAction: "ເຂົ້າລະບົບ", signUpAction: "ສ້າງບັນຊີ", signOut: "ອອກລະບົບ", buyPlan: "ເປີດແພັກເກດ", renewPlan: "ຕໍ່ອາຍຸ", forgotPassword: "ລືມລະຫັດຜ່ານ?" },
  vi: { brandSub: "Bảng điều khiển sinh viên", overview: "Tổng quan", subscription: "Gói đăng ký", setup: "Hướng dẫn", pricing: "Gói cước", billing: "Đơn hàng", referrals: "Giới thiệu", support: "Hỗ trợ", account: "Tài khoản", welcome: "Chào mừng trở lại", active: "Đang hoạt động", expired: "Đã hết hạn", inactive: "Chưa kích hoạt", remaining: "Dung lượng còn lại", copySubscription: "Sao chép liên kết", syncSubscription: "Cập nhật đăng ký", signIn: "Đăng nhập CheapVPN", signUp: "Tạo tài khoản", email: "Email", password: "Mật khẩu", name: "Tên", signInAction: "Đăng nhập", signUpAction: "Tạo tài khoản", signOut: "Đăng xuất", buyPlan: "Kích hoạt gói", renewPlan: "Gia hạn", forgotPassword: "Quên mật khẩu?" },
  ru: { brandSub: "Студенческая консоль", overview: "Обзор", subscription: "Подписка", setup: "Настройка", pricing: "Тарифы", billing: "Заказы", referrals: "Приглашения", support: "Поддержка", account: "Аккаунт", welcome: "С возвращением", active: "Активна", expired: "Истекла", inactive: "Не активна", remaining: "Остаток трафика", copySubscription: "Копировать ссылку", syncSubscription: "Обновить подписку", signIn: "Войти в CheapVPN", signUp: "Создать аккаунт", email: "Эл. почта", password: "Пароль", name: "Имя", signInAction: "Войти", signUpAction: "Создать аккаунт", signOut: "Выйти", buyPlan: "Подключить тариф", renewPlan: "Продлить", forgotPassword: "Забыли пароль?" },
  ja: { brandSub: "学生向けサブスクリプション", overview: "概要", subscription: "サブスクリプション", setup: "設定ガイド", pricing: "料金プラン", billing: "注文", referrals: "紹介", support: "サポート", account: "アカウント", welcome: "おかえりなさい", active: "有効", expired: "期限切れ", inactive: "未契約", remaining: "残り通信量", copySubscription: "リンクをコピー", syncSubscription: "サブスクリプションを更新", signIn: "CheapVPN にログイン", signUp: "アカウントを作成", email: "メール", password: "パスワード", name: "名前", signInAction: "ログイン", signUpAction: "アカウントを作成", signOut: "ログアウト", buyPlan: "プランを開始", renewPlan: "更新する", forgotPassword: "パスワードを忘れた場合" },
  ko: { brandSub: "학생 구독 콘솔", overview: "개요", subscription: "구독", setup: "설정 안내", pricing: "요금제", billing: "주문", referrals: "추천", support: "지원", account: "계정", welcome: "다시 오신 것을 환영합니다", active: "사용 중", expired: "만료됨", inactive: "미개통", remaining: "남은 데이터", copySubscription: "링크 복사", syncSubscription: "구독 업데이트", signIn: "CheapVPN 로그인", signUp: "계정 만들기", email: "이메일", password: "비밀번호", name: "이름", signInAction: "로그인", signUpAction: "계정 만들기", signOut: "로그아웃", buyPlan: "요금제 시작", renewPlan: "갱신", forgotPassword: "비밀번호를 잊으셨나요?" },
  ms: { brandSub: "Konsol langganan pelajar", overview: "Gambaran keseluruhan", subscription: "Langganan", setup: "Panduan", pricing: "Pelan", billing: "Pesanan", referrals: "Rujukan", support: "Sokongan", account: "Akaun", welcome: "Selamat kembali", active: "Aktif", expired: "Tamat tempoh", inactive: "Belum aktif", remaining: "Data berbaki", copySubscription: "Salin pautan", syncSubscription: "Kemas kini langganan", signIn: "Log masuk CheapVPN", signUp: "Cipta akaun", email: "E-mel", password: "Kata laluan", name: "Nama", signInAction: "Log masuk", signUpAction: "Cipta akaun", signOut: "Log keluar", buyPlan: "Aktifkan pelan", renewPlan: "Perbaharui", forgotPassword: "Lupa kata laluan?" },
  id: { brandSub: "Konsol langganan pelajar", overview: "Ringkasan", subscription: "Langganan", setup: "Panduan", pricing: "Paket", billing: "Pesanan", referrals: "Referal", support: "Dukungan", account: "Akun", welcome: "Selamat datang kembali", active: "Aktif", expired: "Kedaluwarsa", inactive: "Belum aktif", remaining: "Data tersisa", copySubscription: "Salin tautan", syncSubscription: "Perbarui langganan", signIn: "Masuk CheapVPN", signUp: "Buat akun", email: "Email", password: "Kata sandi", name: "Nama", signInAction: "Masuk", signUpAction: "Buat akun", signOut: "Keluar", buyPlan: "Aktifkan paket", renewPlan: "Perpanjang", forgotPassword: "Lupa kata sandi?" },
};

Object.entries(regionalTranslations).forEach(([code, copy]) => { i18n[code] = { ...i18n.en, ...copy }; });

const supportedLanguages = [
  ["zh", "简体中文"], ["en", "English"], ["fr", "Français"], ["ar", "العربية"], ["th", "ไทย"], ["km", "ខ្មែរ"], ["lo", "ລາວ"], ["vi", "Tiếng Việt"], ["ru", "Русский"], ["ja", "日本語"], ["ko", "한국어"], ["ms", "Bahasa Melayu"], ["id", "Bahasa Indonesia"],
];

const navItems = [
  ["overview", "grid_view", "overview"],
  ["subscription", "vpn_key", "subscription"],
  ["setup", "install_desktop", "setup"],
  ["pricing", "payments", "pricing"],
  ["billing", "receipt_long", "billing"],
  ["referrals", "redeem", "referrals"],
  ["support", "support_agent", "support"],
  ["account", "manage_accounts", "account"],
];

function t(key) {
  return i18n[state.lang][key] || i18n.en[key] || key;
}

function languageOptions() {
  return supportedLanguages.map(([code, label]) => `<option value="${code}" ${state.lang === code ? "selected" : ""}>${label}</option>`).join("");
}

function applyDocumentLanguage() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
}

function remainingGb() {
  return state.usage?.remaining ?? 0;
}

function usagePercent() {
  if (!state.usage?.total || state.usage?.quotaEnforced === false) return 0;
  return Math.round((state.usage.used / state.usage.total) * 100);
}

function subLinks() {
  return state.subscription?.links || { universal: "", clash: "", singbox: "" };
}

function hasActiveSubscription() {
  return state.subscription?.status === "active";
}

function render() {
  scheduleOrderPolling();
  if (isAdminRoute()) {
    renderAdminApp();
    return;
  }
  if (state.loading) {
    document.querySelector("#app").innerHTML = `<div class="loading-screen"><span class="material-symbols-outlined">progress_activity</span><p>Loading CheapVPN...</p></div>`;
    return;
  }
  const resetToken = new URLSearchParams(window.location.search).get("reset");
  if (resetToken && !state.authToken) {
    document.querySelector("#app").innerHTML = renderPasswordReset(resetToken);
    bindPasswordResetEvents(resetToken);
    return;
  }
  if (!state.authToken || !state.user) {
    document.querySelector("#app").innerHTML = renderAuth();
    bindAuthEvents();
    return;
  }
  document.querySelector("#app").innerHTML = `
    <div class="app-shell">
      ${renderSidebar()}
      <main class="main">
        ${renderTopbar()}
        ${renderActiveView()}
      </main>
      ${renderMobileNav()}
    </div>
  `;
  bindEvents();
  if (state.view === "subscription" && hasActiveSubscription()) renderSubscriptionQr();
}

function scheduleOrderPolling() {
  if (orderPollTimer) {
    clearTimeout(orderPollTimer);
    orderPollTimer = null;
  }
  const pendingOrder = state.orders.find((order) => order.status === "pending");
  if (!state.authToken || state.view !== "billing" || !pendingOrder || state.paymentMode === "mock") return;
  orderPollTimer = setTimeout(async () => {
    orderPollTimer = null;
    try {
      const result = await apiRequest(`/orders/${encodeURIComponent(pendingOrder.id)}`);
      const index = state.orders.findIndex((order) => order.id === result.order.id);
      if (index >= 0) state.orders[index] = result.order;
      if (result.order.status === "paid") {
        state.view = "overview";
        await loadRemoteState();
        showToast(t("paymentConfirmed"));
      } else if (["failed", "expired", "cancelled"].includes(result.order.status)) {
        render();
        showToast(t("paymentFailed"));
      } else {
        render();
      }
    } catch { /* Keep the order visible; the next scheduled check or manual refresh can retry. */ }
  }, 15000);
}

async function renderSubscriptionQr() {
  const canvas = document.querySelector("#subscription-qr");
  const link = subLinks().universal;
  if (!canvas || !link) return;
  try {
    await QRCode.toCanvas(canvas, link, { width: 240, margin: 2, errorCorrectionLevel: "M", color: { dark: "#17323c", light: "#ffffff" } });
  } catch {
    const panel = canvas.closest(".qr-panel-content");
    if (panel) panel.insertAdjacentText("beforeend", "二维码生成失败，请复制订阅链接");
  }
}

function renderAdminApp() {
  if (adminState.loading) {
    document.querySelector("#app").innerHTML = `<div class="admin-loading"><span class="material-symbols-outlined">progress_activity</span><p>Loading control center...</p></div>`;
    return;
  }
  if (!adminState.token) {
    document.querySelector("#app").innerHTML = renderAdminLogin();
    bindAdminLogin();
    return;
  }
  const views = { overview: renderAdminOverview, users: renderAdminUsers, orders: renderAdminOrders, tickets: renderAdminTickets, plans: renderAdminPlans, upstream: renderAdminUpstream };
  document.querySelector("#app").innerHTML = `
    <div class="admin-shell">
      <aside class="admin-sidebar">
        <div class="admin-brand"><span class="admin-logo">C</span><div><strong>CheapVPN</strong><small>Control Center</small></div></div>
        <div class="admin-kicker">OPERATIONS</div>
        <nav class="admin-nav">
          ${adminNav("overview", "space_dashboard", "概览")}
          ${adminNav("users", "groups", "用户与用量")}
          ${adminNav("orders", "receipt_long", "订单")}
          ${adminNav("tickets", "support_agent", "工单")}
          ${adminNav("plans", "sell", "套餐")}
          ${adminNav("upstream", "key_vertical", "资源配置")}
        </nav>
        <div class="admin-sidebar-foot"><span class="admin-pulse"></span>API online<div class="admin-sidebar-note">管理员模式<br />上游凭证仅在服务端保存</div></div>
      </aside>
      <main class="admin-main">
        <header class="admin-topbar"><div><span class="admin-eyebrow">CHEAPVPN / ADMIN</span><h1>${adminState.view === "overview" ? "运营概览" : adminState.view === "users" ? "用户与用量" : adminState.view === "orders" ? "订单管理" : adminState.view === "tickets" ? "客户工单" : adminState.view === "plans" ? "套餐管理" : "资源配置"}</h1></div><div class="admin-top-actions"><span class="admin-date">${new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</span><button class="admin-ghost" id="admin-change-password">修改密码</button><button class="admin-ghost" id="admin-logout">退出后台</button></div></header>
        ${views[adminState.view]()}
      </main>
    </div>
  `;
  injectAdminTokenResetButtons();
  bindAdminEvents();
}

function renderAdminLogin() {
  return `<main class="admin-login"><section class="admin-login-card"><div class="admin-brand admin-brand-large"><span class="admin-logo">C</span><div><strong>CheapVPN</strong><small>Control Center</small></div></div><span class="admin-eyebrow">PRIVATE OPERATIONS</span><h1>进入控制中心</h1><p>管理上游订阅、查看用户状态与用量。</p><form id="admin-login-form"><label>管理员密码<input id="admin-password" type="password" placeholder="输入后台密码" autocomplete="current-password" required /></label><button class="admin-primary" type="submit">安全登录<span class="material-symbols-outlined">arrow_forward</span></button></form><div class="admin-login-error">${adminState.error}</div><a class="admin-back" href="/">返回用户端</a></section></main>`;
}

function adminNav(id, icon, label) {
  return `<button class="admin-nav-item ${adminState.view === id ? "active" : ""}" data-admin-view="${id}"><span class="material-symbols-outlined">${icon}</span>${label}</button>`;
}

function injectAdminTokenResetButtons() {
  if (adminState.view !== "users") return;
  document.querySelectorAll("[data-subscription-action='expire']").forEach((expireButton) => {
    if (expireButton.disabled) return;
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "admin-usage-edit";
    resetButton.dataset.subscriptionAction = "reset";
    resetButton.dataset.userId = expireButton.dataset.userId;
    resetButton.textContent = "重置 Token";
    expireButton.parentElement?.insertBefore(resetButton, expireButton);
  });
}

function renderAdminOverview() {
  const metrics = adminState.metrics || { users: 0, activeSubscriptions: 0, usedGb: 0, totalGb: 0 };
  const usedPercent = metrics.totalGb ? Math.round((metrics.usedGb / metrics.totalGb) * 100) : 0;
  const system = adminState.system || {};
  const check = (label, ok, detail) => `<div class="admin-readiness-row"><span class="admin-status ${ok ? "good" : "warn"}"><i></i>${ok ? "就绪" : "待配置"}</span><strong>${label}</strong><small>${detail}</small></div>`;
  return `<section class="admin-view"><div class="admin-hero"><div><span class="admin-eyebrow">TODAY'S SIGNAL</span><h2>服务运行在清晰的数字上</h2><p>从用户增长到订阅流量，所有关键状态集中在这里。</p></div><span class="admin-hero-mark">⌁</span></div><div class="admin-metric-grid">${adminMetric("注册用户", metrics.users, "people", "blue")}${adminMetric("有效订阅", metrics.activeSubscriptions, "verified", "green")}${adminMetric("已用流量", `${Number(metrics.usedGb).toFixed(1)} GB`, "data_usage", "orange")}${adminMetric("总配额", `${Number(metrics.totalGb).toFixed(1)} GB`, "stacked_bar_chart", "ink")}</div><div class="admin-two-col"><div class="admin-card admin-chart-card"><div class="admin-card-heading"><div><span class="admin-eyebrow">CAPACITY</span><h3>订阅流量池</h3></div><span class="admin-chart-value">${usedPercent}%</span></div><div class="admin-wide-progress"><span style="width:${Math.min(100, usedPercent)}%"></span></div><div class="admin-chart-legend"><span><i class="legend-used"></i>已用 ${Number(metrics.usedGb).toFixed(1)} GB</span><span><i class="legend-total"></i>分配 ${Number(metrics.totalGb).toFixed(1)} GB</span></div><div class="admin-mini-bars"><i style="height:42%"></i><i style="height:55%"></i><i style="height:48%"></i><i style="height:70%"></i><i style="height:62%"></i><i style="height:82%"></i><i style="height:76%"></i><i style="height:92%"></i></div></div><div class="admin-card admin-source-card"><div class="admin-card-heading"><div><span class="admin-eyebrow">SUBSCRIPTION SOURCE</span><h3>当前资源状态</h3></div><span class="admin-status ${adminState.upstream?.configured ? "good" : "warn"}"><i></i>${adminState.upstream?.configured ? "已配置" : "演示模式"}</span></div><p class="admin-source-url">${escapeHtml(adminSourceLabel())}</p><p class="admin-source-note">凭证由服务端加密保存，用户端不会看到上游地址。</p><button class="admin-primary admin-small" data-admin-view="upstream">管理资源<span class="material-symbols-outlined">arrow_forward</span></button></div></div><div class="admin-card admin-readiness-card mt-6"><div class="admin-card-heading"><div><span class="admin-eyebrow">LAUNCH READINESS</span><h3>上线准备状态</h3></div><span class="admin-form-hint">公开地址：${escapeHtml(system.publicBaseUrl || "-")}</span></div><div class="admin-readiness-grid">${check("支付流程", system.payment?.productionReady, system.payment?.mode === "mock" ? "仅演示支付，生产环境需切换 manual 或 webhook" : `${system.payment?.mode || "-"}${system.payment?.checkoutConfigured ? " · 已配置收银页" : ""}`)}${check("上游资源", system.upstream?.enabled > 0, `${system.upstream?.enabled || 0} 个启用 / ${system.upstream?.total || 0} 个已配置`)}${check("客户级用量", system.usage?.apiConfigured, system.usage?.automaticSync ? "已启用自动同步" : "未配置供应商 API，可手工导入")}${check("数据加密", system.security?.encryptionKeyConfigured, system.security?.encryptionKeyConfigured ? "服务端密钥已配置" : "请设置 ADMIN_ENCRYPTION_KEY")}${check("后台密码", system.security?.adminPasswordStrong, system.security?.adminPasswordStrong ? "强度符合上线要求" : "请更换默认或过短密码")}</div></div></section>`;
}

function adminMetric(label, value, icon, tone) {
  return `<div class="admin-metric admin-${tone}"><span class="material-symbols-outlined">${icon}</span><div><span>${label}</span><strong>${value}</strong></div></div>`;
}

function adminSourceLabel() {
  return adminState.sources.length ? `${adminState.sources.length} 个货源已配置` : "尚未配置货源";
}

function renderAdminUsers() {
  const usageInterval = Number(adminState.system?.usage?.syncIntervalMs || 0);
  const rows = adminState.users.map((user) => `<tr><td><div class="admin-user-cell"><span class="admin-avatar">${escapeHtml(user.name.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></div></div></td><td><span class="admin-table-status ${user.subscriptionStatus === "active" ? "good" : "muted"}">${user.subscriptionStatus === "active" ? "有效订阅" : "未开通"}</span></td><td><div class="admin-usage-cell"><strong>${Number(user.usedGb).toFixed(1)} / ${Number(user.totalGb).toFixed(0)} GB</strong><span><i style="width:${user.totalGb ? Math.min(100, (user.usedGb / user.totalGb) * 100) : 0}%"></i></span><small>${user.usageSource === "upstream-aggregate" ? "上游汇总 · 不代表独立客户用量" : user.usageSource === "provider-api" ? "供应商 API" : user.usageSource === "provider-import" ? "供应商导入" : "手动校准"}</small><button class="admin-usage-edit" data-user-usage="${user.id}" data-current-usage="${Number(user.usedGb).toFixed(1)}" ${user.totalGb ? "" : "disabled"}>校准</button><button class="admin-usage-edit" data-user-history="${user.id}">历史</button></div></td><td>${user.devices || "-"}</td><td>${escapeHtml(user.expiresAt)}</td><td><select class="admin-source-select" data-user-source="${user.id}" ${user.subscriptionStatus !== "active" ? "disabled" : ""}>${adminSourceOptions(user.sourceName)}</select></td><td class="admin-token">${escapeHtml(user.token)}</td><td><button class="admin-usage-edit" data-subscription-action="extend" data-user-id="${user.id}" ${user.subscriptionStatus === "inactive" ? "disabled" : ""}>+${user.periodMonths || 1}月</button><button class="admin-usage-edit" data-subscription-action="expire" data-user-id="${user.id}" ${user.subscriptionStatus !== "active" ? "disabled" : ""}>停用</button></td></tr>`).join("");
  const pagination = adminState.userPagination || { page: 1, pages: 1, total: adminState.users.length };
  return `<section class="admin-view"><div class="admin-section-intro"><div><span class="admin-eyebrow">CUSTOMERS</span><h2>用户与用量</h2><p>查看订阅状态、配额消耗和每个用户使用的货源。</p></div><div class="admin-user-toolbar"><form id="admin-user-search" class="admin-inline-search"><input value="${escapeHtml(adminState.userQuery)}" placeholder="搜索姓名或邮箱" aria-label="搜索姓名或邮箱" /><button class="admin-outline" type="submit">搜索</button></form><button class="admin-primary" id="admin-refresh-users"><span class="material-symbols-outlined">refresh</span>刷新数据</button></div></div><div class="admin-card admin-table-wrap"><table class="admin-table"><thead><tr><th>用户</th><th>状态</th><th>本周期用量</th><th>设备</th><th>到期时间</th><th>绑定货源</th><th>订阅 Token</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="admin-empty">暂无用户数据</td></tr>`}</tbody></table><div class="admin-pagination"><span>共 ${pagination.total || 0} 位用户 · 第 ${pagination.page || 1} / ${pagination.pages || 1} 页</span><div><button class="admin-ghost" data-user-page="${Math.max(1, (pagination.page || 1) - 1)}" ${(pagination.page || 1) <= 1 ? "disabled" : ""}>上一页</button><button class="admin-ghost" data-user-page="${Math.min(pagination.pages || 1, (pagination.page || 1) + 1)}" ${(pagination.page || 1) >= (pagination.pages || 1) ? "disabled" : ""}>下一页</button></div></div></div><div class="admin-card admin-config-card mt-6"><div class="admin-card-heading"><div><span class="admin-eyebrow">PROVIDER USAGE</span><h3>客户用量同步</h3></div><span class="admin-status good"><i></i>服务端处理</span></div><p class="admin-form-hint">可使用供应商 API 自动同步，也可以粘贴供应商导出的 JSON。服务端会校验客户、订阅和套餐配额。</p><form id="usage-config-form" class="admin-form"><label>供应商用量 API 地址<input id="usage-api-url" type="url" placeholder="${escapeHtml(adminState.usageSettings?.url ? `已配置：${adminState.usageSettings.url}；留空保持` : "输入 https://provider.example.com/usage")}" autocomplete="off" /></label><label>供应商 API Token<input id="usage-api-token" type="password" placeholder="留空保持当前 Token" autocomplete="new-password" /></label><div class="admin-config-actions"><label class="flex items-center gap-2"><input id="usage-clear-url" type="checkbox" />清除已保存的 API 地址</label><label class="flex items-center gap-2"><input id="usage-clear-token" type="checkbox" />清除已保存的 Token</label></div><label>自动同步周期<select id="usage-sync-interval"><option value="0" ${usageInterval === 0 ? "selected" : ""}>关闭自动同步</option><option value="300000" ${usageInterval === 300000 ? "selected" : ""}>每 5 分钟</option><option value="900000" ${usageInterval === 900000 ? "selected" : ""}>每 15 分钟</option><option value="3600000" ${usageInterval === 3600000 ? "selected" : ""}>每 1 小时</option></select></label><div class="admin-config-actions"><button class="admin-outline" type="submit">保存用量接口</button><span class="admin-form-hint" id="usage-config-hint">${adminState.system?.usage?.apiConfigured ? "服务端已配置用量 API，留空会保留" : "当前未配置客户级用量 API"}</span></div></form><div class="admin-config-actions"><button class="admin-primary" id="usage-sync-btn"><span class="material-symbols-outlined">sync</span>同步供应商 API</button><span class="admin-form-hint" id="usage-sync-hint">未配置 API 时请使用下方手工导入。</span></div><textarea id="usage-import-json" class="admin-import-textarea" rows="5" placeholder='[{"email":"student@example.com","usedGb":12.5}]'></textarea><div class="admin-config-actions"><button class="admin-outline" id="usage-import-btn"><span class="material-symbols-outlined">upload</span>导入用量</button><span class="admin-form-hint" id="usage-import-hint">最多 500 条，超出套餐配额的记录会被拒绝。</span></div></div></section>`;
}

function renderAdminPaymentConfig() {
  const payment = adminState.system?.payment || {};
  const settings = adminState.paymentSettings || {};
  const email = adminState.emailSettings || {};
  return `<div class="admin-card admin-config-card mt-6"><div class="admin-card-heading"><div><span class="admin-eyebrow">PAYMENT SETTINGS</span><h3>下单与收款配置</h3></div><span class="admin-status ${payment.productionReady ? "good" : "warn"}"><i></i>${payment.productionReady ? "生产就绪" : "待配置"}</span></div><p class="admin-form-hint">人工收款可立即使用。自动开通需由支付平台向 <code>${escapeHtml((adminState.system?.publicBaseUrl || window.location.origin).replace(/\/$/, ""))}/api/webhooks/payment</code> 发送通用 HMAC-SHA256 回调；不同平台如采用专用签名格式，需要另做适配。</p><form id="payment-config-form" class="admin-form grid md:grid-cols-2 gap-4"><label>支付模式<select id="payment-mode"><option value="mock" ${payment.mode === "mock" ? "selected" : ""}>模拟支付（仅开发）</option><option value="manual" ${payment.mode === "manual" ? "selected" : ""}>人工收款</option><option value="webhook" ${payment.mode === "webhook" ? "selected" : ""}>通用签名 Webhook</option></select></label><label>收银页地址模板<input id="payment-checkout-template" type="text" inputmode="url" value="${escapeHtml(settings.checkoutTemplate || "")}" placeholder="https://pay.example/checkout?order_id={orderId}&amount={amount}" autocomplete="off" /></label><label class="md:col-span-2">人工收款说明<textarea id="payment-manual-instructions" rows="3" placeholder="例如：请转账后把订单号发给客服。">${escapeHtml(settings.manualInstructions || "")}</textarea></label><label>Webhook 密钥<input id="payment-webhook-secret" type="password" placeholder="留空保持当前密钥" autocomplete="new-password" /></label><label class="flex items-center gap-2"><input id="payment-clear-secret" type="checkbox" />清除当前 Webhook 密钥</label><div class="admin-config-actions md:col-span-2"><button class="admin-outline" type="submit">保存支付配置</button><span class="admin-form-hint" id="payment-config-hint">当前模式：${escapeHtml(payment.mode || "mock")} · 收银页${payment.checkoutConfigured ? "已配置" : "未配置"} · Webhook 密钥${payment.webhookConfigured ? "已配置" : "未配置"}</span></div></form></div><div class="admin-card admin-config-card mt-6"><div class="admin-card-heading"><div><span class="admin-eyebrow">ACCOUNT RECOVERY</span><h3>找回密码邮件</h3></div><span class="admin-status ${email.configured ? "good" : "warn"}"><i></i>${email.configured ? "已配置" : "待配置"}</span></div><p class="admin-form-hint">使用 Resend 发送 30 分钟有效、只能使用一次的重置链接。密钥加密保存在服务端，不会返回浏览器。</p><form id="email-config-form" class="admin-form"><label>Resend API Key<input id="email-resend-api-key" type="password" placeholder="留空保持当前密钥" autocomplete="new-password" /></label><label>发件人<input id="email-from" value="${escapeHtml(email.from || "")}" placeholder="CheapVPN <support@example.com>" autocomplete="off" /></label><div class="admin-config-actions"><button class="admin-outline" type="submit">保存邮件设置</button><span class="admin-form-hint" id="email-config-hint">${email.configured ? "密码找回邮件已就绪" : "请添加 Resend API Key 与已验证发件人"}</span></div></form></div>`;
}

function renderAdminOrders() {
  const rows = adminState.orders.map((order) => `<tr><td class="admin-token">${escapeHtml(order.id.slice(0, 8))}...</td><td><div class="admin-user-cell"><span class="admin-avatar">${escapeHtml(order.user.name.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(order.user.name)}</strong><small>${escapeHtml(order.user.email)}</small></div></div></td><td>${escapeHtml(order.planName)}<small class="block">${order.kind === "renewal" ? "续费" : "首次开通"}${order.discountPercent ? ` · ${order.discountPercent}% 优惠` : ""}</small></td><td>¥${Number(order.amount).toFixed(2)}</td><td><span class="admin-table-status ${order.status === "paid" ? "good" : order.status === "pending" ? "warn" : "muted"}">${order.status === "paid" ? "已支付" : order.status === "pending" ? (order.paymentSubmission ? "待核验" : "待支付") : escapeHtml(order.status)}</span></td><td>${order.paymentSubmission ? `<strong>${escapeHtml(order.paymentSubmission.method || "manual")}</strong><small class="block">${escapeHtml(order.paymentSubmission.reference)}</small><small class="block">${escapeHtml(order.paymentSubmission.submittedAt)}</small>${order.paymentSubmission.note ? `<small class="block">${escapeHtml(order.paymentSubmission.note)}</small>` : ""}` : "-"}</td><td>${escapeHtml(order.createdAt)}</td><td>${order.status === "pending" ? `<button class="admin-usage-edit" data-order-action="confirm" data-order-id="${escapeHtml(order.id)}">确认收款</button><button class="admin-usage-edit" data-order-id="${escapeHtml(order.id)}" data-order-action="cancel">取消</button>` : "-"}</td></tr>`).join("");
  const pagination = adminState.orderPagination || { page: 1, pages: 1, total: adminState.orders.length };
  return `<section class="admin-view"><div class="admin-section-intro"><div><span class="admin-eyebrow">ORDERS</span><h2>订单管理</h2><p>查看订单状态、客户提交的付款流水号，并确认人工收款。</p></div><form id="admin-order-search" class="admin-inline-search"><input value="${escapeHtml(adminState.orderQuery)}" placeholder="搜索客户或订单号" aria-label="搜索客户或订单号" /><select id="admin-order-status"><option value="">全部状态</option><option value="pending" ${adminState.orderStatus === "pending" ? "selected" : ""}>待支付</option><option value="paid" ${adminState.orderStatus === "paid" ? "selected" : ""}>已支付</option><option value="failed" ${adminState.orderStatus === "failed" ? "selected" : ""}>失败</option><option value="cancelled" ${adminState.orderStatus === "cancelled" ? "selected" : ""}>已取消</option><option value="expired" ${adminState.orderStatus === "expired" ? "selected" : ""}>已过期</option></select><button class="admin-outline" type="submit">筛选</button></form></div><div class="admin-card admin-table-wrap"><table class="admin-table"><thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>付款信息</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="admin-empty">暂无订单</td></tr>`}</tbody></table><div class="admin-pagination"><span>共 ${pagination.total || 0} 个订单 · 第 ${pagination.page || 1} / ${pagination.pages || 1} 页</span><div><button class="admin-ghost" data-order-page="${Math.max(1, (pagination.page || 1) - 1)}" ${(pagination.page || 1) <= 1 ? "disabled" : ""}>上一页</button><button class="admin-ghost" data-order-page="${Math.min(pagination.pages || 1, (pagination.page || 1) + 1)}" ${(pagination.page || 1) >= (pagination.pages || 1) ? "disabled" : ""}>下一页</button></div></div></div>${renderAdminPaymentConfig()}</section>`;
}

function renderAdminTickets() {
  const rows = adminState.tickets.map((ticket) => `<tr><td class="admin-token">${escapeHtml(ticket.id)}</td><td><div class="admin-user-cell"><span class="admin-avatar">${escapeHtml((ticket.user?.name || "?").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(ticket.subject)}</strong><small>${escapeHtml(ticket.user?.email || "-")}</small></div></div></td><td>${escapeHtml(ticket.device || "-")}<small class="block">${escapeHtml(ticket.client || "-")}</small></td><td class="admin-ticket-description">${escapeHtml(ticket.description)}</td><td><select class="admin-ticket-status" data-ticket-status="${escapeHtml(ticket.id)}"><option value="open" ${ticket.status === "open" ? "selected" : ""}>待处理</option><option value="in_progress" ${ticket.status === "in_progress" ? "selected" : ""}>处理中</option><option value="resolved" ${ticket.status === "resolved" ? "selected" : ""}>已解决</option><option value="closed" ${ticket.status === "closed" ? "selected" : ""}>已关闭</option></select></td><td>${escapeHtml(ticket.createdAt)}</td></tr>`).join("");
  return `<section class="admin-view"><div class="admin-section-intro"><div><span class="admin-eyebrow">SUPPORT</span><h2>客户工单</h2><p>处理客户提交的连接、订阅和客户端问题。</p></div><button class="admin-primary" id="admin-refresh-tickets"><span class="material-symbols-outlined">refresh</span>刷新工单</button></div><div class="admin-card admin-table-wrap"><table class="admin-table"><thead><tr><th>工单</th><th>客户</th><th>设备 / 客户端</th><th>问题描述</th><th>状态</th><th>提交时间</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="admin-empty">暂无工单</td></tr>`}</tbody></table></div></section>`;
}

function renderAdminPlans() {
  const cards = adminState.plans.map((plan) => `<article class="admin-card p-5"><div class="flex items-center justify-between gap-3"><div><span class="admin-eyebrow">${escapeHtml(plan.slug)}</span><h3>${escapeHtml(plan.name)}</h3></div><span class="admin-status ${plan.active ? "good" : "warn"}"><i></i>${plan.active ? "启用" : "停用"}</span></div><div class="grid grid-cols-2 gap-3 mt-5"><div class="panel-soft p-3"><small>首个周期</small><strong>¥${Number(plan.firstMonth).toFixed(2)}</strong></div><div class="panel-soft p-3"><small>续费周期</small><strong>¥${Number(plan.renewal).toFixed(2)}</strong></div><div class="panel-soft p-3"><small>周期长度</small><strong>${plan.periodMonths || 1} 个月</strong></div><div class="panel-soft p-3"><small>周期流量</small><strong>${Number(plan.dataTotal).toFixed(0)} GB</strong></div><div class="panel-soft p-3"><small>设备</small><strong>${plan.devices} 台</strong></div></div><div class="flex gap-3 mt-5"><button class="admin-outline" data-plan-edit="${plan.id}">编辑套餐</button><button class="admin-outline" data-plan-toggle="${plan.id}" data-plan-active="${plan.active}">${plan.active ? "停用" : "启用"}</button>${adminState.plans.length > 1 ? `<button class="admin-ghost" data-plan-delete="${plan.id}" ${plan.active && adminState.plans.filter((item) => item.active).length <= 1 ? "disabled" : ""}>停用套餐</button>` : ""}</div></article>`).join("");
  return `<section class="admin-view"><div class="admin-section-intro"><div><span class="admin-eyebrow">PRODUCT CATALOG</span><h2>套餐管理</h2><p>统一维护价格、周期、流量配额和设备上限。</p></div></div><div class="grid xl:grid-cols-3 gap-5">${cards}</div><div class="admin-card admin-config-card mt-6"><div class="admin-card-heading"><div><span class="admin-eyebrow">ADD PLAN</span><h3>新增套餐</h3></div></div><form id="plan-form" class="admin-form grid md:grid-cols-2 gap-4"><label>套餐标识<input id="plan-slug" placeholder="student-plus" pattern="[a-z0-9-]+" required /></label><label>套餐名称<input id="plan-name" placeholder="留学生进阶版" required /></label><label>首个周期价格<input id="plan-first" type="number" min="0" step="0.01" placeholder="9.9" required /></label><label>续费周期价格<input id="plan-renewal" type="number" min="0" step="0.01" placeholder="19.9" required /></label><label>周期长度（月）<input id="plan-period" type="number" min="1" max="24" step="1" value="1" required /></label><label>周期流量 GB<input id="plan-data" type="number" min="0" step="0.1" placeholder="50" required /></label><label>设备数<input id="plan-devices" type="number" min="1" max="100" step="1" placeholder="2" required /></label><div><button class="admin-primary" type="submit">保存套餐<span class="material-symbols-outlined">add</span></button></div><p class="admin-form-hint" id="plan-form-hint">周期为 1 表示月付，12 表示年付；已有订阅不会被删除。</p></form></div></section>`;
}

function renderAdminUpstream() {
  const cards = adminState.sources.map((source) => {
    const rules = (source.nodeRules || []).map((rule) => `${rule.match}=${rule.name}`).join("\n");
    return `<article class="source-card"><div class="source-card-top"><div class="source-title"><span class="source-icon material-symbols-outlined">${source.isDefault ? "star" : "hub"}</span><div><strong>${escapeHtml(source.name)}</strong><small>${source.isDefault ? "默认货源" : "备用货源"}</small></div></div><span class="admin-status ${source.enabled ? "good" : "warn"}"><i></i>${source.enabled ? "启用" : "停用"}</span></div><div class="source-url">${escapeHtml(source.maskedUrl)}</div><div class="source-card-meta"><span>同步：${escapeHtml(source.lastSyncStatus)}</span><span>${escapeHtml(source.lastSyncAt)}</span></div><label class="source-rules-label">节点地区映射<small>每行一条：原名称关键词=国旗 新名称，例如 CF官方优选 1=🇬🇧 英国优选 01</small><textarea class="source-rules" data-source-rules="${source.id}" placeholder="CF官方优选 1=🇬🇧 英国优选 01\nCF官方优选 2=🇯🇵 日本优选 02">${escapeHtml(rules)}</textarea></label><div class="source-card-actions"><button class="admin-outline admin-source-edit" data-source-edit="${source.id}">编辑货源</button><button class="admin-outline admin-source-toggle" data-source-toggle="${source.id}" data-source-enabled="${source.enabled}">${source.enabled ? "停用货源" : "启用货源"}</button><button class="admin-outline admin-source-test" data-source-test="${source.id}">测试连接</button><button class="admin-outline admin-source-discover" data-source-discover="${source.id}">自动检测</button><button class="admin-outline admin-source-rules-save" data-source-rules-save="${source.id}">保存映射</button><button class="admin-outline admin-source-sync" data-source-sync="${source.id}"><span class="material-symbols-outlined">sync</span>同步</button><button class="admin-ghost admin-source-default" data-source-default="${source.id}">${source.isDefault ? "默认中" : "设为默认"}</button><button class="admin-ghost admin-source-delete" data-source-delete="${source.id}"><span class="material-symbols-outlined">delete</span></button></div></article>`;
  }).join("");
  const assignmentMode = adminState.system?.upstream?.assignmentMode || "default";
  return `<section class="admin-view"><div class="admin-section-intro"><div><span class="admin-eyebrow">SOURCE CONFIGURATION</span><h2>多货源管理</h2><p>配置多个供应商的订阅地址，按用户绑定不同货源。</p></div><span class="admin-lock"><span class="material-symbols-outlined">lock</span>Encrypted at rest</span></div><div class="source-grid">${cards || `<div class="admin-card source-empty">还没有配置货源，先添加一个供应商。</div>`}</div><div class="admin-config-grid source-config-bottom"><div class="admin-card admin-config-card"><div class="admin-card-heading"><div><span class="admin-eyebrow">ADD SOURCE</span><h3>添加新货源</h3></div><span class="admin-status warn"><i></i>Token 不出前台</span></div><form id="upstream-form" class="admin-form"><label>货源名称<input id="upstream-name" type="text" placeholder="例如：供应商 A / 香港线路" required /></label><label>通用 / Base64 地址<input id="upstream-url" type="url" placeholder="https://example.com/sub?token=...&b64" autocomplete="off" required /></label><label>Clash 地址（可选）<input id="upstream-clash-url" type="url" placeholder="https://example.com/sub?token=...&clash" autocomplete="off" /></label><label>SingBox 地址（可选）<input id="upstream-singbox-url" type="url" placeholder="https://example.com/sub?token=...&sb" autocomplete="off" /></label><p class="admin-form-hint">通用地址给 Shadowrocket 使用；Clash 和 SingBox 请填写供应商对应格式地址。地址会在服务端加密保存。</p><button class="admin-primary" type="submit">保存新货源<span class="material-symbols-outlined">add_link</span></button></form></div><div class="admin-card admin-sync-card"><span class="admin-eyebrow">SOURCE ROUTING</span><h3>新客户分配策略</h3><p>轮询会把新客户稳定分配到不同启用货源；续费客户保持原货源。</p><div class="admin-routing-row"><select id="assignment-mode"><option value="default" ${assignmentMode === "default" ? "selected" : ""}>默认货源</option><option value="round_robin" ${assignmentMode === "round_robin" ? "selected" : ""}>轮询分配</option></select><button class="admin-outline" id="assignment-mode-save">保存策略</button></div><span class="admin-eyebrow mt-5">SYNC CONTROL</span><h3>批量更新订阅</h3><p>立即请求所有启用货源，并刷新绑定用户的缓存。单个货源也可以单独同步。</p><button class="admin-outline" id="admin-sync-all"><span class="material-symbols-outlined">sync</span>同步全部货源</button><div id="admin-sync-result" class="admin-sync-result"></div></div></div></section>`;
}

function adminSourceOptions(selectedName) {
  return `<option value="">自动使用默认货源</option>${adminState.sources.map((source) => `<option value="${source.id}" ${selectedName === source.name ? "selected" : ""}>${escapeHtml(source.name)}${source.isDefault ? " · 默认" : ""}</option>`).join("")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function renderAuth() {
  return `
    <main class="auth-shell">
      <div class="auth-language"><label for="auth-lang-select">Language</label><select id="auth-lang-select">${languageOptions()}</select></div>
      <section class="auth-card panel">
        <div class="brand-lockup">
          <div class="brand-mark"><span class="material-symbols-outlined">shield_lock</span></div>
          <div><strong>CheapVPN</strong><span>${t("brandSub")}</span></div>
        </div>
        <div class="auth-heading"><p>${t("welcome")}</p><h1>${t("signIn")}</h1></div>
        <form id="auth-form" class="auth-form">
          <label>${t("email")}<input id="auth-email" type="email" value="${state.demoEnabled ? "demo@cheapvpn.local" : ""}" required /></label>
          <label>${t("password")}<input id="auth-password" type="password" value="${state.demoEnabled ? "demo1234" : ""}" minlength="8" required /></label>
          <label id="name-field" class="hidden">${t("name")}<input id="auth-name" /></label>
          <label id="referral-field" class="hidden">${t("referralCode")}<input id="auth-referral" value="${new URLSearchParams(window.location.search).get("ref") || localStorage.getItem("cheapvpn_referral_code") || ""}" /></label>
          <button class="btn btn-primary w-full" type="submit" id="auth-submit">${t("signInAction")}</button>
        </form>
        <p id="auth-error" class="auth-error">${state.apiError}</p>
        <div class="auth-foot"><button type="button" id="auth-forgot">${t("forgotPassword")}</button><button type="button" id="auth-mode">${t("signUp")}</button></div>
        ${state.demoEnabled ? `<button class="btn btn-secondary w-full mt-4" type="button" id="demo-login">${t("useDemo")}</button>` : ""}
      </section>
    </main>
  `;
}

function renderPasswordReset(token) {
  return `<main class="auth-shell"><section class="auth-card panel"><div class="brand-lockup"><div class="brand-mark"><span class="material-symbols-outlined">lock_reset</span></div><div><strong>CheapVPN</strong><span>${t("brandSub")}</span></div></div><div class="auth-heading"><p>${t("account")}</p><h1>${t("resetPasswordTitle")}</h1></div><form id="password-reset-form" class="auth-form"><label>${t("newPassword")}<input id="password-reset-new" type="password" minlength="8" autocomplete="new-password" required /></label><label>${t("confirmPassword")}<input id="password-reset-confirm" type="password" minlength="8" autocomplete="new-password" required /></label><button class="btn btn-primary w-full" type="submit">${t("resetPassword")}</button></form><p id="password-reset-message" class="auth-error"></p><div class="auth-foot"><a href="/">${t("signInAction")}</a></div></section></main>`;
}

function bindPasswordResetEvents(token) {
  document.querySelector("#password-reset-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.querySelector("#password-reset-message");
    const password = document.querySelector("#password-reset-new").value;
    if (password !== document.querySelector("#password-reset-confirm").value) { message.textContent = t("confirmPassword"); return; }
    try {
      await apiRequest("/auth/password/reset", { method: "POST", body: { token, newPassword: password } });
      message.textContent = t("resetPasswordDone");
      window.history.replaceState({}, "", "/");
    } catch (error) { message.textContent = error.message; }
  });
}

function bindAuthEvents() {
  let signUp = false;
  document.querySelector("#auth-lang-select")?.addEventListener("change", (event) => {
    state.lang = event.target.value;
    localStorage.setItem("cheapvpn_lang", state.lang);
    applyDocumentLanguage();
    render();
  });
  document.querySelector("#auth-mode")?.addEventListener("click", () => {
    signUp = !signUp;
    document.querySelector("#name-field")?.classList.toggle("hidden", !signUp);
    document.querySelector("#referral-field")?.classList.toggle("hidden", !signUp);
    document.querySelector("#auth-submit").textContent = signUp ? t("signUpAction") : t("signInAction");
    document.querySelector("#auth-mode").textContent = signUp ? t("signInAction") : t("signUp");
  });
  document.querySelector("#auth-forgot")?.addEventListener("click", () => {
    const email = window.prompt(t("email"));
    if (!email) return;
    apiRequest("/auth/password/forgot", { method: "POST", body: { email } })
      .then(() => { const message = document.querySelector("#auth-error"); if (message) message.textContent = t("resetPasswordSent"); })
      .catch((error) => { const message = document.querySelector("#auth-error"); if (message) message.textContent = error.message; });
  });
  document.querySelector("#demo-login")?.addEventListener("click", () => submitAuth("login", "demo@cheapvpn.local", "demo1234", ""));
  document.querySelector("#auth-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAuth(signUp ? "register" : "login", document.querySelector("#auth-email").value, document.querySelector("#auth-password").value, document.querySelector("#auth-name")?.value || "", document.querySelector("#auth-referral")?.value || "");
  });
}

async function submitAuth(mode, email, password, name, referralCode = "") {
  state.apiError = "";
  state.loading = true;
  render();
  try {
    const result = await apiRequest(`/auth/${mode}`, { method: "POST", body: { email, password, name, referralCode } });
    state.authToken = result.token;
    state.user = result.user;
    localStorage.setItem("cheapvpn_session", result.token);
    localStorage.removeItem("cheapvpn_referral_code");
    await loadRemoteState();
  } catch (error) {
    state.loading = false;
    state.apiError = error.message;
    render();
  }
}

async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}), ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || t("apiUnavailable"));
      error.status = response.status;
      error.code = data.error?.code || "";
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeout = new Error(t("apiUnavailable"));
      timeout.code = "REQUEST_TIMEOUT";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function adminApiRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...(adminState.token ? { Authorization: `Bearer ${adminState.token}` } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) {
        const error = new Error("后台服务版本较旧，请重启 npm run server");
        error.status = response.status;
        throw error;
      }
      const error = new Error(data.error?.message || "后台请求失败");
      error.status = response.status;
      error.code = data.error?.code || "";
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeout = new Error("后台请求超时，请检查 API 服务");
      timeout.code = "REQUEST_TIMEOUT";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function bindAdminLogin() {
  document.querySelector("#admin-login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    adminState.error = "";
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const result = await adminApiRequest("/admin/auth/login", { method: "POST", body: { password: document.querySelector("#admin-password").value } });
      adminState.token = result.token;
      localStorage.setItem("cheapvpn_admin_session", result.token);
      await loadAdminState();
    } catch (error) {
      adminState.error = error.message;
      button.disabled = false;
      renderAdminApp();
    }
  });
}

async function loadAdminState() {
  if (!adminState.token) {
    adminState.loading = false;
    renderAdminApp();
    return;
  }
  try {
    const userQuery = new URLSearchParams({ q: adminState.userQuery, page: String(adminState.userPage), pageSize: "50" });
    const orderQuery = new URLSearchParams({ q: adminState.orderQuery, status: adminState.orderStatus, page: String(adminState.orderPage), pageSize: "50" });
    const [overview, users, orders, tickets, upstream, plans, system, paymentSettings, usageSettings, emailSettings] = await Promise.all([
      adminApiRequest("/admin/overview"),
      adminApiRequest(`/admin/users?${userQuery}`),
      adminApiRequest(`/admin/orders?${orderQuery}`),
      adminApiRequest("/admin/tickets"),
      adminApiRequest("/admin/upstream"),
      adminApiRequest("/admin/plans"),
      adminApiRequest("/admin/system"),
      adminApiRequest("/admin/settings/payment"),
      adminApiRequest("/admin/settings/usage"),
      adminApiRequest("/admin/settings/email"),
    ]);
    adminState.metrics = overview.metrics;
    adminState.users = users.users;
    adminState.userPagination = users.pagination;
    adminState.orders = orders.orders;
    adminState.orderPagination = orders.pagination;
    adminState.tickets = tickets.tickets;
    adminState.plans = plans.plans;
    adminState.upstream = upstream;
    adminState.system = system;
    adminState.paymentSettings = paymentSettings;
    adminState.usageSettings = usageSettings;
    adminState.emailSettings = emailSettings;
    adminState.sources = overview.sources || upstream.sources || [];
    adminState.error = "";
  } catch (error) {
    adminState.error = error.message;
    if (/sign-in|unauthorized/i.test(error.message)) {
      adminState.token = null;
      localStorage.removeItem("cheapvpn_admin_session");
    }
  }
  adminState.loading = false;
  renderAdminApp();
}

function bindAdminEvents() {
  const refreshUsersButton = document.querySelector("#admin-refresh-users");
  if (refreshUsersButton && !document.querySelector("#admin-export-users")) {
    const exportButton = document.createElement("button");
    exportButton.id = "admin-export-users";
    exportButton.className = "admin-outline";
    exportButton.innerHTML = '<span class="material-symbols-outlined">download</span>导出 CSV';
    refreshUsersButton.parentElement?.insertBefore(exportButton, refreshUsersButton);
  }
  document.querySelectorAll("[data-admin-view]").forEach((button) => {
    button.addEventListener("click", () => {
      adminState.view = button.dataset.adminView;
      renderAdminApp();
    });
  });
  document.querySelector("#plan-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await adminApiRequest("/admin/plans", { method: "POST", body: {
        slug: document.querySelector("#plan-slug").value, name: document.querySelector("#plan-name").value,
        firstMonth: Number(document.querySelector("#plan-first").value), renewal: Number(document.querySelector("#plan-renewal").value),
        periodMonths: Number(document.querySelector("#plan-period").value), dataTotal: Number(document.querySelector("#plan-data").value), devices: Number(document.querySelector("#plan-devices").value),
      } });
      await loadAdminState();
    } catch (error) {
      document.querySelector("#plan-form-hint").textContent = error.message;
      button.disabled = false;
    }
  });
  document.querySelectorAll("[data-plan-toggle]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const plan = adminState.plans.find((item) => String(item.id) === event.currentTarget.dataset.planToggle);
      if (!plan) return;
      event.currentTarget.disabled = true;
      try { await adminApiRequest(`/admin/plans/${plan.id}`, { method: "PUT", body: { active: !plan.active } }); await loadAdminState(); }
      catch (error) { showAdminMessage(error.message); event.currentTarget.disabled = false; }
    });
  });
  document.querySelectorAll("[data-plan-edit]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const plan = adminState.plans.find((item) => String(item.id) === event.currentTarget.dataset.planEdit);
      if (!plan) return;
      const name = window.prompt("套餐名称", plan.name);
      if (name === null) return;
      const firstMonth = window.prompt("首月价格", plan.firstMonth);
      if (firstMonth === null) return;
      const renewal = window.prompt("续费价格", plan.renewal);
      if (renewal === null) return;
      const periodMonths = window.prompt("周期长度（月）", plan.periodMonths || 1);
      if (periodMonths === null) return;
      const dataTotal = window.prompt("每月流量 GB", plan.dataTotal);
      if (dataTotal === null) return;
      const devices = window.prompt("设备数", plan.devices);
      if (devices === null) return;
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/plans/${plan.id}`, { method: "PUT", body: {
          slug: plan.slug, name: name.trim(), firstMonth: Number(firstMonth), renewal: Number(renewal),
          periodMonths: Number(periodMonths), dataTotal: Number(dataTotal), devices: Number(devices), active: plan.active,
        } });
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-plan-delete]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      if (!window.confirm("停用这个套餐？现有订阅不会被删除。")) return;
      try { await adminApiRequest(`/admin/plans/${event.currentTarget.dataset.planDelete}`, { method: "DELETE" }); await loadAdminState(); }
      catch (error) { showAdminMessage(error.message); }
    });
  });
  document.querySelectorAll("[data-order-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const action = event.currentTarget.dataset.orderAction;
      if (action === "cancel" && !window.confirm("取消这个待支付订单？")) return;
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/orders/${event.currentTarget.dataset.orderId}/${action}`, { method: "POST" });
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelector("#admin-refresh-tickets")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    await loadAdminState();
  });
  document.querySelectorAll("[data-ticket-status]").forEach((select) => {
    select.addEventListener("change", async (event) => {
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/tickets/${event.currentTarget.dataset.ticketStatus}`, { method: "PATCH", body: { status: event.currentTarget.value } });
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelector("#admin-logout")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try { await adminApiRequest("/admin/auth/logout", { method: "POST" }); } catch { /* Clear local state even if the server is unavailable. */ }
    adminState.token = null;
    localStorage.removeItem("cheapvpn_admin_session");
    renderAdminApp();
  });

  document.querySelector("#admin-change-password")?.addEventListener("click", async (event) => {
    const currentPassword = window.prompt("请输入当前后台密码");
    if (currentPassword === null) return;
    const newPassword = window.prompt("请输入新的后台密码（至少 12 位）");
    if (newPassword === null) return;
    event.currentTarget.disabled = true;
    try {
      await adminApiRequest("/admin/auth/password", { method: "POST", body: { currentPassword, newPassword } });
      showToast("后台密码已更新");
    } catch (error) {
      showToast(error.message);
    } finally { event.currentTarget.disabled = false; }
  });
  document.querySelector("#admin-refresh-users")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    await loadAdminState();
  });
  document.querySelector("#admin-export-users")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const query = new URLSearchParams({ q: adminState.userQuery });
      const response = await fetch(`${API_BASE}/admin/users/export.csv?${query}`, { headers: { Authorization: `Bearer ${adminState.token}` } });
      if (!response.ok) throw new Error("导出客户数据失败");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `cheapvpn-users-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showAdminMessage(error.message);
    } finally { event.currentTarget.disabled = false; }
  });
  document.querySelector("#admin-user-search")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    adminState.userQuery = String(event.currentTarget.querySelector("input")?.value || "").trim();
    adminState.userPage = 1;
    await loadAdminState();
  });
  document.querySelectorAll("[data-user-page]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      adminState.userPage = Number(event.currentTarget.dataset.userPage) || 1;
      await loadAdminState();
    });
  });
  document.querySelector("#admin-order-search")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    adminState.orderQuery = String(event.currentTarget.querySelector("input")?.value || "").trim();
    adminState.orderStatus = String(document.querySelector("#admin-order-status")?.value || "");
    adminState.orderPage = 1;
    await loadAdminState();
  });
  document.querySelectorAll("[data-order-page]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      adminState.orderPage = Number(event.currentTarget.dataset.orderPage) || 1;
      await loadAdminState();
    });
  });
  document.querySelector("#usage-config-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const hint = document.querySelector("#usage-config-hint");
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const body = { syncIntervalMs: Number(document.querySelector("#usage-sync-interval")?.value || 0), clearUrl: Boolean(document.querySelector("#usage-clear-url")?.checked), clearToken: Boolean(document.querySelector("#usage-clear-token")?.checked) };
      const url = document.querySelector("#usage-api-url")?.value?.trim() || "";
      const token = document.querySelector("#usage-api-token")?.value?.trim() || "";
      if (url) body.url = url;
      if (token) body.token = token;
      await adminApiRequest("/admin/settings/usage", { method: "PUT", body });
      if (hint) hint.textContent = "用量接口配置已加密保存";
      await loadAdminState();
    } catch (error) {
      if (hint) hint.textContent = error.message;
      button.disabled = false;
    }
  });
  document.querySelector("#payment-config-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const hint = document.querySelector("#payment-config-hint");
    const button = event.currentTarget.querySelector("button[type=submit]");
    const secret = document.querySelector("#payment-webhook-secret")?.value || "";
    button.disabled = true;
    try {
      const body = {
        mode: document.querySelector("#payment-mode")?.value || "mock",
        checkoutTemplate: document.querySelector("#payment-checkout-template")?.value || "",
        manualInstructions: document.querySelector("#payment-manual-instructions")?.value || "",
        clearWebhookSecret: Boolean(document.querySelector("#payment-clear-secret")?.checked),
      };
      if (secret) body.webhookSecret = secret;
      await adminApiRequest("/admin/settings/payment", { method: "PUT", body });
      if (hint) hint.textContent = "支付配置已加密保存并立即生效";
      await loadAdminState();
    } catch (error) {
      if (hint) hint.textContent = error.message;
      button.disabled = false;
    }
  });
  document.querySelector("#email-config-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const hint = document.querySelector("#email-config-hint");
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const body = { from: document.querySelector("#email-from")?.value?.trim() || "" };
      const resendApiKey = document.querySelector("#email-resend-api-key")?.value?.trim() || "";
      if (resendApiKey) body.resendApiKey = resendApiKey;
      await adminApiRequest("/admin/settings/email", { method: "PUT", body });
      if (hint) hint.textContent = "邮件设置已加密保存";
      await loadAdminState();
    } catch (error) {
      if (hint) hint.textContent = error.message;
      button.disabled = false;
    }
  });
  document.querySelector("#usage-sync-btn")?.addEventListener("click", async (event) => {
    const hint = document.querySelector("#usage-sync-hint");
    event.currentTarget.disabled = true;
    try {
      const result = await adminApiRequest("/admin/usage/sync", { method: "POST" });
      if (hint) hint.textContent = `同步完成：更新 ${result.updated.length} 条，拒绝 ${result.rejected.length} 条。`;
      await loadAdminState();
    } catch (error) {
      if (hint) hint.textContent = error.message;
      event.currentTarget.disabled = false;
    }
  });
  document.querySelector("#usage-import-btn")?.addEventListener("click", async (event) => {
    const hint = document.querySelector("#usage-import-hint");
    const input = document.querySelector("#usage-import-json");
    let records;
    try {
      records = JSON.parse(input?.value || "");
      if (!Array.isArray(records)) throw new Error("必须是 JSON 数组");
    } catch (error) {
      if (hint) hint.textContent = `格式错误：${error.message}`;
      return;
    }
    event.currentTarget.disabled = true;
    try {
      const result = await adminApiRequest("/admin/usage/import", { method: "POST", body: { records } });
      if (hint) hint.textContent = `已更新 ${result.updated.length} 条，拒绝 ${result.rejected.length} 条。`;
      input.value = "";
      await loadAdminState();
    } catch (error) {
      if (hint) hint.textContent = error.message;
      event.currentTarget.disabled = false;
    }
  });
  document.querySelector("#upstream-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await adminApiRequest("/admin/sources", { method: "POST", body: { name: document.querySelector("#upstream-name").value, url: document.querySelector("#upstream-url").value, clashUrl: document.querySelector("#upstream-clash-url")?.value, singboxUrl: document.querySelector("#upstream-singbox-url")?.value } });
      await loadAdminState();
    } catch (error) {
      document.querySelector(".admin-form-hint").textContent = error.message;
      button.disabled = false;
    }
  });
  document.querySelectorAll("[data-source-discover]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const sourceId = event.currentTarget.dataset.sourceDiscover;
      const textarea = document.querySelector(`[data-source-rules="${sourceId}"]`);
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "检测中...";
      try {
        const result = await adminApiRequest(`/admin/sources/${sourceId}/node-discovery`, { method: "POST" });
        if (textarea) textarea.value = result.rules.map((rule) => `${rule.match}=${rule.name}`).join("\n");
        showAdminMessage(`${result.nodes.length} 个节点${result.cached ? "已从最近检测结果读取" : "已检测"}并填入建议。${result.warning}`);
      } catch (error) {
        showAdminMessage(error.message);
      } finally {
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = "自动检测";
      }
    });
  });
  document.querySelectorAll("[data-source-toggle]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const sourceId = event.currentTarget.dataset.sourceToggle;
      const enabled = event.currentTarget.dataset.sourceEnabled !== "true";
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/sources/${sourceId}`, { method: "PUT", body: { enabled } });
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-source-edit]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const source = adminState.sources.find((item) => String(item.id) === event.currentTarget.dataset.sourceEdit);
      if (!source) return;
      const name = window.prompt("货源名称", source.name);
      if (name === null) return;
      const url = window.prompt("新的通用 / Base64 地址（留空保留原地址）", "");
      if (url === null) return;
      const clashUrl = window.prompt("新的 Clash 地址（留空保留，输入 CLEAR 清空）", "");
      if (clashUrl === null) return;
      const singboxUrl = window.prompt("新的 SingBox 地址（留空保留，输入 CLEAR 清空）", "");
      if (singboxUrl === null) return;
      event.currentTarget.disabled = true;
      try {
        const body = { name: name.trim(), url: url.trim(), enabled: source.enabled, isDefault: source.isDefault };
        if (clashUrl.trim()) body.clashUrl = clashUrl.trim().toUpperCase() === "CLEAR" ? null : clashUrl.trim();
        if (singboxUrl.trim()) body.singboxUrl = singboxUrl.trim().toUpperCase() === "CLEAR" ? null : singboxUrl.trim();
        await adminApiRequest(`/admin/sources/${source.id}`, { method: "PUT", body });
        showAdminMessage("货源已更新，绑定客户将在下次同步时使用新地址");
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-source-test]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "测试中...";
      try {
        const result = await adminApiRequest(`/admin/sources/${event.currentTarget.dataset.sourceTest}/test`, { method: "POST" });
         const detail = result.formats.map((format) => `${format.format}: ${format.ok ? "成功" : "失败"}${format.nodes !== null && format.nodes !== undefined ? `（${format.nodes} 个节点）` : ""}`).join("，");
        showAdminMessage(`${result.source}：${result.passed}/${result.total} 格式可用。${detail}`);
      } catch (error) {
        showAdminMessage(error.message);
      } finally {
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = "测试连接";
      }
    });
  });
  document.querySelectorAll("[data-source-rules-save]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const sourceId = event.currentTarget.dataset.sourceRulesSave;
      const textarea = document.querySelector(`[data-source-rules="${sourceId}"]`);
      const rules = String(textarea?.value || "").split(/\r?\n/).map((line) => {
        const separator = line.indexOf("=");
        return separator > 0 ? { match: line.slice(0, separator).trim(), name: line.slice(separator + 1).trim() } : null;
      }).filter(Boolean);
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/sources/${sourceId}/node-rules`, { method: "PUT", body: { rules } });
        showAdminMessage("节点地区映射已保存，请点击同步");
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-user-source]").forEach((select) => {
    select.addEventListener("change", async (event) => {
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/users/${event.currentTarget.dataset.userSource}/source`, { method: "PUT", body: { sourceId: event.currentTarget.value || null } });
        await loadAdminState();
      } catch (error) {
        event.currentTarget.disabled = false;
        showAdminMessage(error.message);
      }
    });
  });
  document.querySelectorAll("[data-user-usage]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const current = event.currentTarget.dataset.currentUsage;
      const value = window.prompt("请输入已用流量（GB）", current);
      if (value === null) return;
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/users/${event.currentTarget.dataset.userUsage}/usage`, { method: "PATCH", body: { usedGb: Number(value) } });
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-user-history]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        const result = await adminApiRequest(`/admin/users/${event.currentTarget.dataset.userHistory}/usage/history?limit=20`);
        const lines = result.history.length
          ? result.history.map((item) => `${item.capturedAt} · ${Number(item.usedGb).toFixed(1)} / ${Number(item.totalGb).toFixed(1)} GB · ${item.source}`).join("\n")
          : "暂无用量快照";
        window.alert(`${result.user.name} 的用量历史\n\n${lines}`);
      } catch (error) { showAdminMessage(error.message); }
      finally { event.currentTarget.disabled = false; }
    });
  });
  document.querySelectorAll("[data-subscription-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const action = event.currentTarget.dataset.subscriptionAction;
      if (action === "expire" && !window.confirm("立即停用这个客户的订阅？")) return;
      if (action === "reset" && !window.confirm("重置这个客户的订阅 Token？旧链接会立即失效。")) return;
      event.currentTarget.disabled = true;
      try {
        await adminApiRequest(`/admin/users/${event.currentTarget.dataset.userId}/subscription`, { method: "PATCH", body: { action } });
        await loadAdminState();
      } catch (error) {
        showAdminMessage(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-source-sync]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        const result = await adminApiRequest(`/admin/sources/${event.currentTarget.dataset.sourceSync}/sync`, { method: "POST" });
        showAdminMessage(`${result.source}：${result.success} 个成功，${result.stale} 个保留旧缓存，${result.errors || 0} 个失败`);
        await loadAdminState();
      } catch (error) { showAdminMessage(error.message); event.currentTarget.disabled = false; }
    });
  });
  document.querySelectorAll("[data-source-default]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      try {
        await adminApiRequest(`/admin/sources/${event.currentTarget.dataset.sourceDefault}`, { method: "PUT", body: { isDefault: true } });
        await loadAdminState();
      } catch (error) { showAdminMessage(error.message); }
    });
  });
  document.querySelectorAll("[data-source-delete]").forEach((button) => {
    button.addEventListener("click", async (event) => {
       if (!window.confirm("删除这个货源？仍有有效订阅绑定时，系统会阻止删除。")) return;
      try {
        await adminApiRequest(`/admin/sources/${event.currentTarget.dataset.sourceDelete}`, { method: "DELETE" });
        await loadAdminState();
      } catch (error) { showAdminMessage(error.message); }
    });
  });
  document.querySelector("#admin-sync-all")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await adminApiRequest("/admin/sync", { method: "POST" });
      document.querySelector("#admin-sync-result").textContent = `已完成：${result.success} 成功，${result.stale} 个保留旧缓存，${result.errors || 0} 个失败`;
    } catch (error) {
      document.querySelector("#admin-sync-result").textContent = error.message;
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  document.querySelector("#assignment-mode-save")?.addEventListener("click", async (event) => {
    const select = document.querySelector("#assignment-mode");
    event.currentTarget.disabled = true;
    try {
      await adminApiRequest("/admin/settings/routing", { method: "PUT", body: { assignmentMode: select?.value || "default" } });
      showAdminMessage("新客户货源分配策略已保存");
      await loadAdminState();
    } catch (error) {
      showAdminMessage(error.message);
      event.currentTarget.disabled = false;
    }
  });
}

function showAdminMessage(message) {
  const target = document.querySelector("#admin-sync-result") || document.querySelector(".admin-login-error");
  if (target) target.textContent = message;
}

async function loadRemoteState() {
  if (!state.authToken) {
    state.loading = false;
    render();
    return;
  }
  try {
    const [me, plans, referral, orders, tickets, payment, usageHistory] = await Promise.all([apiRequest("/me"), apiRequest("/plans"), apiRequest("/referral"), apiRequest("/orders"), apiRequest("/support/tickets"), apiRequest("/payment/config"), apiRequest("/usage/history")]);
    state.user = me.user;
    state.plans = plans.plans;
    state.subscription = me.subscription;
    state.referral = referral;
    state.orders = orders.orders || [];
    state.tickets = tickets.tickets || [];
    state.paymentMode = payment.mode || "mock";
    state.paymentConfig = payment;
    state.usageHistory = usageHistory.history || [];
    if (state.subscription?.status === "active") {
      state.plan = state.subscription.plan;
      state.usage = await apiRequest("/usage");
    } else if (state.subscription) {
      state.plan = state.subscription.plan;
      state.usage = { used: 0, total: state.plan.dataTotal, remaining: 0, devices: state.plan.devices, expiresAt: state.subscription.expiresAt };
    } else {
      state.plan = state.plans[0] || null;
      state.usage = state.plan ? { used: 0, total: state.plan.dataTotal, remaining: state.plan.dataTotal, devices: state.plan.devices, expiresAt: "-" } : null;
    }
    state.apiError = "";
  } catch (error) {
    state.apiError = error.message;
    if (error.status === 401) {
      localStorage.removeItem("cheapvpn_session");
      state.authToken = null;
      state.user = null;
    }
  }
  state.loading = false;
  render();
}

function startRemoteRefresh() {
  if (remoteRefreshTimer) return;
  remoteRefreshTimer = window.setInterval(async () => {
    if (!state.authToken || isAdminRoute() || document.visibilityState === "hidden" || remoteRefreshInFlight) return;
    remoteRefreshInFlight = true;
    try { await loadRemoteState(); } finally { remoteRefreshInFlight = false; }
  }, 60 * 1000);
}

function renderSidebar() {
  const subscriptionStatus = state.subscription?.status === "active" ? "active" : state.subscription?.status === "expired" ? "expired" : "inactive";
  const statusClass = subscriptionStatus === "active" ? "text-emerald-700" : "text-amber-700";
  return `
    <aside class="sidebar">
      <div class="flex items-center gap-3 mb-9">
        <div class="brand-mark"><span class="material-symbols-outlined">shield_lock</span></div>
        <div>
          <div class="font-bold text-xl leading-tight">CheapVPN</div>
          <div class="text-sm text-slate-500 font-semibold">${t("brandSub")}</div>
        </div>
      </div>
      <nav class="space-y-2">${navItems.map(renderNavButton).join("")}</nav>
      <div class="panel-soft p-4 mt-8">
        <div class="text-xs font-bold text-slate-500 uppercase">${t("planStatus")}</div>
        <div class="mt-3 flex items-center gap-2 ${statusClass} font-bold">
          <span class="dot"></span>${t(subscriptionStatus)}
        </div>
        <div class="text-sm text-slate-600 mt-3 leading-relaxed">
          ${state.plan?.name || t("noSubscription")}<br />
          ${state.plan ? `¥${state.plan.renewal} / ${planPeriodLabel(state.plan)} · ${state.plan.dataTotal}GB` : ""}
        </div>
      </div>
    </aside>
  `;
}

function renderMobileNav() {
  return `<nav class="mobile-nav">${navItems.map(renderNavButton).join("")}</nav>`;
}

function renderNavButton([id, icon, label]) {
  return `
    <button class="nav-btn ${state.view === id ? "active" : ""}" data-view="${id}">
      <span class="material-symbols-outlined">${icon}</span>
      <span class="nav-label">${t(label)}</span>
    </button>
  `;
}

function renderTopbar() {
  const subscriptionStatus = state.subscription?.status === "active" ? "active" : state.subscription?.status === "expired" ? "expired" : "inactive";
  const statusClass = subscriptionStatus === "active" ? "text-emerald-700 bg-emerald-50 border border-emerald-200" : "text-amber-700 bg-amber-50 border border-amber-200";
  return `
    <header class="topbar">
      <div>
        <p class="text-slate-500 font-semibold">${t("welcome")}, ${state.user.name}</p>
        <h1 class="text-4xl font-bold tracking-tight mt-2">${pageTitle()}</h1>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <span class="status-pill ${statusClass}">
          <span class="dot"></span>${t(subscriptionStatus)}
        </span>
        <select id="lang-select" class="panel-soft px-4 py-3 text-sm font-bold outline-none">
          ${languageOptions()}
        </select>
        <button class="btn btn-secondary" id="user-logout" type="button">${t("signOut")}</button>
      </div>
    </header>
  `;
}

function pageTitle() {
  const item = navItems.find(([id]) => id === state.view);
  return item ? t(item[2]) : t("overview");
}

function renderActiveView() {
  const views = {
    overview: renderOverview,
    subscription: renderSubscription,
    setup: renderSetup,
    pricing: renderPricing,
    referrals: renderReferrals,
    billing: renderBilling,
    support: renderSupport,
    account: renderAccount,
  };
  return `<section class="view active">${views[state.view]()}</section>`;
}

function renderOverview() {
  const plan = state.plan || { name: t("noSubscription"), dataTotal: 0, devices: 0, renewal: 0, firstMonth: 0 };
  return `
    <div class="grid xl:grid-cols-[1.55fr_0.9fr] gap-6">
      <div class="panel p-7">
        <div class="grid lg:grid-cols-[1fr_1.1fr] gap-8">
          <div>
            <p class="text-lg text-slate-500 font-bold">${plan.name}</p>
            <div class="text-6xl font-bold mt-6 tracking-tight">${remainingGb().toFixed(1)}GB</div>
            <p class="text-xl text-slate-500 font-semibold mt-3">${t("remaining")}</p>
          </div>
          <div>
            <div class="flex justify-between text-lg font-bold">
              <span>${t("usedThisCycle")}</span>
              <span>${state.usage?.used || 0} / ${plan.dataTotal}GB</span>
            </div>
            <div class="progress-track mt-4">
              <div class="progress-fill" style="width:${usagePercent()}%"></div>
            </div>
            <div class="grid sm:grid-cols-3 gap-4 mt-7">
              ${metric(t("expires"), state.usage?.expiresAt || "-")}
              ${metric(t("devices"), state.usage?.devices || plan.devices)}
              ${metric(t("renewal"), `¥${plan.renewal} / ${planPeriodLabel(plan)}`)}
            </div>
          </div>
        </div>
        ${renderUsageHistory()}
        <p class="text-lg text-slate-600 leading-relaxed mt-8">${hasActiveSubscription() ? t("dashboardNote") : t("expiredSubscription")}</p>
        ${state.usage?.usageSource === "upstream-aggregate" ? `<div class="notice notice-warn mt-5"><span class="material-symbols-outlined">info</span><span>${t("aggregateUsageWarning")}</span></div>` : ""}
        <div class="flex flex-wrap gap-4 mt-7">
          <button class="btn btn-primary" data-copy="universal" ${hasActiveSubscription() ? "" : "disabled"}>
            <span class="material-symbols-outlined">content_copy</span>${t("copySubscription")}
          </button>
          <button class="btn btn-secondary" data-view="subscription">
            <span class="material-symbols-outlined">qr_code_2</span>${t("showQr")}
          </button>
          <button class="btn btn-secondary" id="sync-btn" ${hasActiveSubscription() ? "" : "disabled"}>
            <span class="material-symbols-outlined">sync</span>${t("syncSubscription")}
          </button>
        </div>
      </div>
      <div class="panel p-7">
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-2xl font-bold">${t("serviceCardTitle")}</h2>
          <span class="status-pill text-emerald-700 bg-emerald-50 border border-emerald-200">
            <span class="dot"></span>Healthy
          </span>
        </div>
        <p class="text-lg text-slate-600 leading-relaxed mt-6">${t("serviceCardText")}</p>
        <div class="grid sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 gap-4 mt-8">
          ${metric(t("firstMonth"), `¥${plan.firstMonth}`)}
          ${metric("Token", state.subscription?.token || "-")}
        </div>
      </div>
    </div>
  `;
}

function renderUsageHistory() {
  const history = state.usageHistory || [];
  if (!history.length) return "";
  const points = [...history].reverse().slice(-8);
  return `<div class="mt-8 pt-6 border-t border-slate-200"><div class="flex items-center justify-between gap-3"><h3 class="font-bold text-lg">用量同步记录</h3><span class="text-sm text-slate-500">最近 ${history.length} 次</span></div><div class="usage-history-bars mt-5">${points.map((item) => {
    const used = Math.max(0, Number(item.usedGb) || 0);
    const total = Math.max(1, Number(item.totalGb) || 1);
    const height = Math.max(8, Math.min(100, (used / total) * 100));
    const label = new Date(item.capturedAt).toLocaleDateString(state.lang === "zh" ? "zh-CN" : state.lang);
    return `<div class="usage-history-point" title="${escapeHtml(`${used.toFixed(1)} / ${total.toFixed(1)} GB · ${label}`)}"><span style="height:${height}%"></span><small>${escapeHtml(label.slice(0, 5))}</small></div>`;
  }).join("")}</div></div>`;
}

function renderSubscription() {
  const links = subLinks();
  const syncStatus = state.subscription?.lastSyncStatus || "unknown";
  const syncLabel = syncStatus === "stale" ? "使用最近缓存" : syncStatus === "partial" ? "部分格式成功" : syncStatus === "upstream" || syncStatus === "ok" ? "同步正常" : "演示模式";
  const syncClass = syncStatus === "stale" ? "text-amber-700 bg-amber-50 border border-amber-200" : syncStatus === "partial" ? "text-amber-700 bg-amber-50 border border-amber-200" : "text-emerald-700 bg-emerald-50 border border-emerald-200";
  return `
    <div class="grid xl:grid-cols-[1fr_360px] gap-6">
      <div class="panel p-7">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <div>
            <h2 class="text-2xl font-bold">${t("formatTitle")}</h2>
            <p class="text-slate-500 mt-2">${t("formatHelp")}</p>
          </div>
          <button class="btn btn-danger" id="reset-btn" ${hasActiveSubscription() ? "" : "disabled"}>
            <span class="material-symbols-outlined">restart_alt</span>${t("resetSubscription")}
          </button>
        </div>
        ${linkRow(t("universal"), links.universal, "universal")}
        ${linkRow(t("clash"), links.clash, "clash")}
        ${linkRow(t("singbox"), links.singbox, "singbox")}
      </div>
      <div class="panel p-7">
        <div class="flex items-center justify-between gap-3"><h2 class="text-2xl font-bold">${t("qrTitle")}</h2><span class="status-pill ${syncClass}"><span class="dot"></span>${syncLabel}</span></div>
        <div class="aspect-square rounded-2xl border border-dashed border-slate-300 grid place-items-center bg-slate-50 mt-6">
          <div class="text-center qr-panel-content">
            ${links.universal ? `<canvas id="subscription-qr" width="240" height="240" aria-label="Subscription QR code"></canvas><p class="font-bold mt-3">${t("showQr")}</p><p class="text-xs text-slate-500 mt-2">扫描后导入通用订阅</p>` : `<span class="material-symbols-outlined text-8xl text-blue-700">qr_code_2</span><p class="font-bold mt-3">${t("noSubscription")}</p>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSetup() {
  const devices = [
    ["desktop_windows", "Windows", "Clash Verge Rev / Mihomo Party", "clash"],
    ["laptop_mac", "macOS", "ClashX Meta / Mihomo Party", "clash"],
    ["android", "Android", "Clash Meta for Android / Surfboard", "clash"],
    ["phone_iphone", "iPhone / iPad", "Shadowrocket", "universal"],
  ];
  return `
    <div class="panel p-7">
      <h2 class="text-2xl font-bold">${t("setupTitle")}</h2>
      <p class="text-lg text-slate-600 mt-3">${t("setupText")}</p>
      <div class="grid md:grid-cols-2 xl:grid-cols-4 gap-5 mt-8">
        ${devices.map(([icon, name, client, format]) => {
          const selectedFormat = state.subscription?.links?.[format] ? format : "universal";
          const formatLabel = selectedFormat === "universal" ? "通用 / Shadowrocket" : "Clash";
          return `
          <div class="panel-soft p-5">
            <span class="material-symbols-outlined text-4xl text-blue-700">${icon}</span>
            <h3 class="text-xl font-bold mt-5">${name}</h3>
            <p class="text-slate-600 mt-2">${client}</p>
            <button class="btn btn-secondary mt-5 w-full" data-copy="${selectedFormat}" ${state.subscription?.links?.[selectedFormat] ? "" : "disabled"}>
              <span class="material-symbols-outlined">content_copy</span>复制 ${formatLabel} 订阅
            </button>
          </div>
        `; }).join("")}
      </div>
    </div>
  `;
}

function planPeriodLabel(plan) {
  const months = Number(plan?.periodMonths || 1);
  if (state.lang === "en") return months === 12 ? "year" : `${months} month${months === 1 ? "" : "s"}`;
  return months === 12 ? "年" : `${months}个月`;
}

function renderPricing() {
  const plans = state.plans.length ? state.plans : [state.plan || { id: 0, firstMonth: 0, renewal: 0, dataTotal: 0, devices: 0, periodMonths: 1, name: t("noSubscription") }];
  const renewing = hasActiveSubscription();
  return `
    <div>
      <div class="panel p-7 mb-6"><h2 class="text-2xl font-bold">${t("pricingTitle")}</h2><p class="text-slate-600 mt-3">${t("pricingText")}</p></div>
      <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
        ${plans.map((plan, index) => { const price = renewing ? plan.renewal : plan.firstMonth; return `<div class="panel p-7 ${state.subscription?.plan?.id === plan.id ? "ring-2 ring-blue-600" : ""}"><div class="flex items-center justify-between gap-3"><h3 class="text-2xl font-bold">${plan.name}</h3>${index === 0 ? `<span class="status-pill text-blue-700 bg-blue-50 border border-blue-200">${t("mostPopular")}</span>` : ""}</div><div class="mt-7"><span class="text-5xl font-bold">¥${price}</span><span class="text-slate-500 font-bold"> / ${planPeriodLabel(plan)}</span></div><div class="text-slate-600 mt-3">${t(renewing ? "renewal" : "firstMonth")} ¥${renewing ? plan.renewal : plan.firstMonth} · ${t("renewal")} ¥${plan.renewal} / ${planPeriodLabel(plan)} · ${plan.dataTotal}GB · ${plan.devices} 台设备</div><button class="btn btn-primary w-full mt-7" data-buy-plan="${plan.id}">${state.paymentMode === "mock" ? (renewing ? t("renewPlan") : t("buyPlan")) : t("createOrder")}</button></div>`; }).join("")}
      </div>
    </div>
  `;
}

function renderBilling() {
  const pendingOrder = (state.orders || []).find((order) => order.status === "pending");
  const methods = state.paymentConfig?.methods || [];
  const selectedMethod = state.selectedPaymentMethod || pendingOrder?.paymentSubmission?.method || methods[0]?.id || "";
  const methodLabel = (id) => methods.find((method) => method.id === id)?.label || id || "未选择";
  return `
    <div class="panel p-7">
      <div class="flex flex-wrap items-center justify-between gap-4"><div><h2 class="text-2xl font-bold">${t("orderHistory")}</h2><p class="text-slate-600 mt-3">${t("orderHistoryText")}</p></div><button class="btn btn-secondary" id="refresh-orders"><span class="material-symbols-outlined">refresh</span>刷新订单状态</button></div>
      ${state.paymentMode === "manual" && state.paymentConfig?.manualInstructions ? `<div class="notice notice-info mt-6"><span class="material-symbols-outlined">payments</span><div><strong>人工付款说明</strong><p class="mt-1 whitespace-pre-line">${escapeHtml(state.paymentConfig.manualInstructions)}</p><p class="mt-2 text-sm">付款后请保留订单号，后台确认收款后订阅会自动生效。</p></div></div>` : ""}
      ${pendingOrder && state.paymentMode === "manual" ? `<div class="panel-soft p-5 mt-6"><div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="text-xl font-bold">选择支付方式</h3><p class="text-sm text-slate-600 mt-1">订单金额 ¥${Number(pendingOrder.amount).toFixed(2)}。完成付款后提交对应流水号。</p></div><span class="status-pill text-amber-700 bg-amber-50 border border-amber-200">等待付款</span></div><div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-5">${methods.map((method) => `<button class="panel-soft p-4 text-left border-2 ${selectedMethod === method.id ? "border-blue-600 bg-blue-50" : "border-transparent"}" data-select-payment-method="${escapeHtml(method.id)}"><span class="material-symbols-outlined text-blue-700">${escapeHtml(method.icon || "payments")}</span><strong class="block mt-2">${escapeHtml(method.label)}</strong><small class="text-slate-500">${escapeHtml(method.description || "")}</small></button>`).join("")}</div><p class="text-sm text-slate-500 mt-4">已选择：${escapeHtml(methodLabel(selectedMethod))}。卡片与钱包的敏感信息不会在 CheapVPN 页面填写。</p></div>` : ""}
      <div class="overflow-x-auto mt-7">
        <table class="w-full text-left min-w-[680px]"><thead><tr class="text-sm text-slate-500 border-b border-slate-200">
          <th class="py-3 pr-4">订单</th><th class="py-3 pr-4">类型</th><th class="py-3 pr-4">套餐</th><th class="py-3 pr-4">金额</th><th class="py-3 pr-4">状态</th><th class="py-3 pr-4">时间</th><th class="py-3 text-right">操作</th>
        </tr></thead><tbody>
          ${(state.orders || []).length ? state.orders.map((order) => `<tr class="border-b border-slate-100"><td class="py-4 pr-4 font-mono text-xs"><div>${order.id.slice(0, 8)}...</div><button class="text-blue-700 mt-1" data-copy-order="${escapeHtml(order.id)}">复制完整订单号</button></td><td class="py-4 pr-4">${order.kind === "renewal" ? t("orderTypeRenewal") : t("orderTypeNew")}${order.discountPercent ? ` · ${t("discount")} ${order.discountPercent}%` : ""}</td><td class="py-4 pr-4">${order.planName}</td><td class="py-4 pr-4 font-bold">¥${Number(order.amount).toFixed(2)}</td><td class="py-4 pr-4"><span class="status-pill ${order.status === "paid" ? "text-emerald-700 bg-emerald-50 border border-emerald-200" : order.status === "pending" ? "text-amber-700 bg-amber-50 border border-amber-200" : order.status === "failed" ? "text-rose-700 bg-rose-50 border border-rose-200" : "text-slate-600 bg-slate-100 border border-slate-200"}">${order.status === "paid" ? t("paid") : order.status === "pending" ? (order.paymentSubmission ? "待人工核验" : t("pending")) : order.status === "expired" ? "已过期" : order.status === "failed" ? "支付失败" : "已取消"}</span>${order.paymentSubmission ? `<small class="block text-emerald-700 mt-2">${escapeHtml(methodLabel(order.paymentSubmission.method))} · 已提交：${escapeHtml(order.paymentSubmission.reference)}</small>` : ""}</td><td class="py-4 pr-4 text-sm text-slate-500">${new Date(order.createdAt).toLocaleString()}</td><td class="py-4 text-right">${order.status === "pending" ? `${order.checkoutUrl ? `<a class="btn btn-primary" href="${escapeHtml(order.checkoutUrl)}" target="_blank" rel="noopener">去支付</a>` : ""}${state.paymentMode === "manual" ? `<button class="btn btn-primary" data-submit-payment="${escapeHtml(order.id)}">${order.paymentSubmission ? "更新付款信息" : "我已付款"}</button>` : ""}<button class="btn btn-secondary" data-cancel-order="${order.id}">取消订单</button>` : "-"}</td></tr>`).join("") : `<tr><td colspan="7" class="py-10 text-center text-slate-500">暂无订单</td></tr>`}
        </tbody></table>
      </div>
    </div>
  `;
}

function renderReferrals() {
  const referral = state.referral || { link: `${window.location.origin}/?ref=${state.user.referralCode}`, successfulInvites: 0, pendingInvites: 0, referrals: [] };
  return `
    <div class="grid lg:grid-cols-[1fr_1fr] gap-6">
      <div class="panel p-7">
        <h2 class="text-2xl font-bold">${t("referralTitle")}</h2>
        <p class="text-lg text-slate-600 mt-3">${t("referralText")}</p>
        <div class="grid sm:grid-cols-2 gap-4 mt-7">
          ${metric(t("referralReward"), referral.reward || "10%")}
          ${metric(t("referralCondition"), `${referral.successfulInvites || 0} successful`)}
        </div>
      </div>
      <div class="panel p-7">
        <div class="text-sm font-bold text-slate-500 uppercase">Referral Link</div>
        <div class="link-field mt-4">${referral.link || "-"}</div>
        <button class="btn btn-secondary mt-5" data-copy-ref>
          <span class="material-symbols-outlined">content_copy</span>${t("copySubscription")}
        </button>
      </div>
      <div class="panel p-7 lg:col-span-2">
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-2xl font-bold">邀请记录</h2>
          <span class="text-slate-500">待完成：${referral.pendingInvites || 0}</span>
        </div>
        <div class="mt-5 space-y-3">
          ${(referral.referrals || []).length ? referral.referrals.map((item) => `
            <div class="panel-soft px-4 py-3 flex items-center justify-between gap-4">
              <span class="font-semibold">${item.name || item.email}</span>
              <span class="text-sm ${item.status === "qualified" ? "text-emerald-700" : "text-amber-700"}">${item.status === "qualified" ? "已完成首次付款" : "已注册，待首次付款"}</span>
            </div>`).join("") : `<p class="text-slate-500">还没有邀请记录</p>`}
        </div>
      </div>
    </div>
  `;
}

function renderSupport() {
  return `
    <div class="panel p-7 max-w-4xl">
      <h2 class="text-2xl font-bold">${t("supportTitle")}</h2>
      <p class="text-lg text-slate-600 mt-3">${t("supportText")}</p>
      <form id="support-form" class="mt-7">
        <input id="support-subject" class="panel-soft w-full px-4 py-3 outline-none" placeholder="问题标题 / Subject" required maxlength="120" />
        <div class="grid sm:grid-cols-2 gap-4 mt-4"><input id="support-device" class="panel-soft px-4 py-3 outline-none" placeholder="Device / 设备" maxlength="80" /><input id="support-client" class="panel-soft px-4 py-3 outline-none" placeholder="Client app / 客户端" maxlength="80" /></div>
        <textarea id="support-description" class="panel-soft w-full min-h-36 px-4 py-3 mt-4 outline-none" placeholder="Describe the issue / 描述问题（至少 10 个字符）" minlength="10" maxlength="4000" required></textarea>
        <div class="flex items-center gap-4 mt-5"><button class="btn btn-primary" type="submit"><span class="material-symbols-outlined">send</span>提交工单</button><span id="support-form-message" class="text-sm text-slate-500"></span></div>
      </form>
      <div class="border-t border-slate-200 mt-8 pt-7"><h3 class="text-xl font-bold">我的工单</h3><div class="space-y-3 mt-4">${state.tickets.length ? state.tickets.map((ticket) => `<div class="panel-soft p-4"><div class="flex items-center justify-between gap-3"><strong>${escapeHtml(ticket.subject)}</strong><span class="status-pill ${ticket.status === "resolved" || ticket.status === "closed" ? "text-emerald-700 bg-emerald-50 border border-emerald-200" : "text-amber-700 bg-amber-50 border border-amber-200"}">${ticket.status === "open" ? "待处理" : ticket.status === "in_progress" ? "处理中" : ticket.status === "resolved" ? "已解决" : "已关闭"}</span></div><p class="text-slate-600 mt-2">${escapeHtml(ticket.description)}</p><small class="text-slate-500">${escapeHtml(ticket.createdAt)} · ${escapeHtml(ticket.device || "未填写设备")} · ${escapeHtml(ticket.client || "未填写客户端")}</small></div>`).join("") : `<p class="text-slate-500">还没有提交工单</p>`}</div></div>
    </div>
  `;
}

function renderAccount() {
  return `
    <div class="grid lg:grid-cols-[0.8fr_1.2fr] gap-6">
      <div class="panel p-7">
        <span class="material-symbols-outlined text-5xl text-blue-700">manage_accounts</span>
        <h2 class="text-2xl font-bold mt-5">${t("accountTitle")}</h2>
        <p class="text-slate-600 mt-3 leading-relaxed">${t("accountText")}</p>
        <div class="panel-soft p-4 mt-7"><div class="text-xs font-bold text-slate-500 uppercase">${t("email")}</div><div class="font-bold mt-2 break-all">${escapeHtml(state.user.email)}</div></div>
        <form id="profile-form" class="mt-5"><label class="block font-semibold">${t("name")}<input id="profile-name" class="panel-soft w-full px-4 py-3 mt-2 outline-none" value="${escapeHtml(state.user.name)}" minlength="2" maxlength="80" required /></label><button class="btn btn-secondary mt-4" type="submit">${t("saveProfile")}</button><span id="profile-form-message" class="text-sm text-slate-500 ml-3"></span></form>
      </div>
      <div class="panel p-7">
        <h3 class="text-xl font-bold">${t("changePassword")}</h3>
        <form id="password-form" class="mt-6 space-y-4">
          <label class="block font-semibold">${t("currentPassword")}<input id="current-password" class="panel-soft w-full px-4 py-3 mt-2 outline-none" type="password" autocomplete="current-password" minlength="8" required /></label>
          <label class="block font-semibold">${t("newPassword")}<input id="new-password" class="panel-soft w-full px-4 py-3 mt-2 outline-none" type="password" autocomplete="new-password" minlength="8" required /></label>
          <label class="block font-semibold">${t("confirmPassword")}<input id="confirm-password" class="panel-soft w-full px-4 py-3 mt-2 outline-none" type="password" autocomplete="new-password" minlength="8" required /></label>
          <div class="flex items-center gap-4 pt-2"><button class="btn btn-primary" type="submit">${t("changePassword")}</button><span id="password-form-message" class="text-sm text-slate-500"></span></div>
        </form>
        <div class="border-t border-slate-200 mt-7 pt-6"><p class="text-sm text-slate-600">${t("accountText")}</p><button class="btn btn-secondary mt-4" id="revoke-other-sessions" type="button"><span class="material-symbols-outlined">devices</span>${t("revokeOtherSessions")}</button><span id="sessions-form-message" class="text-sm text-slate-500 ml-3"></span></div>
      </div>
    </div>
  `;
}

function metric(label, value) {
  return `
    <div class="panel-soft p-5 min-w-0">
      <div class="text-sm font-bold text-slate-500 uppercase">${label}</div>
          <div class="text-2xl font-bold mt-2 truncate">${value}</div>
    </div>
  `;
}

function linkRow(label, url, type) {
  return `
    <div class="grid md:grid-cols-[140px_1fr_auto] gap-4 items-center py-4 border-t border-slate-200">
      <div class="font-bold text-slate-700">${label}</div>
      <div class="link-field">${url}</div>
      <button class="btn btn-secondary" data-copy="${type}" ${url ? "" : "disabled"}>
        <span class="material-symbols-outlined">content_copy</span>${t("copySubscription")}
      </button>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    });
  });

  document.querySelector("#lang-select")?.addEventListener("change", (event) => {
    state.lang = event.target.value;
    localStorage.setItem("cheapvpn_lang", state.lang);
    applyDocumentLanguage();
    render();
  });

  document.querySelector("#user-logout")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try { await apiRequest("/auth/logout", { method: "POST" }); } catch { /* Local cleanup still protects this browser. */ }
    localStorage.removeItem("cheapvpn_session");
    state.authToken = null;
    state.user = null;
    state.loading = false;
    render();
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => copyLink(button.dataset.copy));
  });

  document.querySelectorAll("[data-copy-order]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const copied = await copyText(event.currentTarget.dataset.copyOrder);
      showToast(copied ? "订单号已复制" : "复制失败，请长按订单号复制");
    });
  });

  document.querySelector("[data-copy-ref]")?.addEventListener("click", () => {
    copyText(state.referral?.link || `${window.location.origin}/?ref=${state.user.referralCode}`).then((copied) => showToast(copied ? t("copied") : "复制失败，请长按链接复制"));
  });

  document.querySelector("#support-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const message = document.querySelector("#support-form-message");
    button.disabled = true;
    try {
      const result = await apiRequest("/support/tickets", { method: "POST", body: {
        subject: document.querySelector("#support-subject").value,
        device: document.querySelector("#support-device").value,
        client: document.querySelector("#support-client").value,
        description: document.querySelector("#support-description").value,
      } });
      state.tickets = [result.ticket, ...state.tickets];
      event.currentTarget.reset();
      if (message) message.textContent = `工单 ${result.ticket.id} 已提交`;
    } catch (error) {
      if (message) message.textContent = error.message;
    } finally { button.disabled = false; }
  });

  document.querySelector("#password-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const message = document.querySelector("#password-form-message");
    const currentPassword = document.querySelector("#current-password").value;
    const newPassword = document.querySelector("#new-password").value;
    const confirmPassword = document.querySelector("#confirm-password").value;
    if (newPassword !== confirmPassword) {
      if (message) message.textContent = "两次输入的新密码不一致";
      return;
    }
    button.disabled = true;
    try {
      await apiRequest("/auth/password", { method: "POST", body: { currentPassword, newPassword } });
      event.currentTarget.reset();
      if (message) message.textContent = t("passwordChanged");
    } catch (error) {
      if (message) message.textContent = error.message;
    } finally { button.disabled = false; }
  });

  document.querySelector("#revoke-other-sessions")?.addEventListener("click", async (event) => {
    const message = document.querySelector("#sessions-form-message");
    event.currentTarget.disabled = true;
    try {
      const result = await apiRequest("/auth/sessions/revoke-others", { method: "POST" });
      if (message) message.textContent = `${t("sessionsRevoked")} (${result.revoked || 0})`;
    } catch (error) {
      if (message) message.textContent = error.message;
    } finally { event.currentTarget.disabled = false; }
  });

  document.querySelector("#profile-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const message = document.querySelector("#profile-form-message");
    button.disabled = true;
    try {
      const result = await apiRequest("/me/profile", { method: "PATCH", body: { name: document.querySelector("#profile-name").value } });
      state.user = result.user;
      if (message) message.textContent = t("profileSaved");
      render();
    } catch (error) {
      if (message) message.textContent = error.message;
      button.disabled = false;
    }
  });

  document.querySelector("#sync-btn")?.addEventListener("click", () => {
    syncSubscription();
  });

  document.querySelector("#reset-btn")?.addEventListener("click", () => {
    resetSubscription();
  });

  document.querySelectorAll("[data-buy-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (buyInFlight) return;
      button.disabled = true;
      try { await buyPlan(Number(button.dataset.buyPlan)); }
      finally { if (document.body.contains(button)) button.disabled = false; }
    });
  });

  document.querySelectorAll("[data-cancel-order]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const orderId = event.currentTarget.dataset.cancelOrder;
      if (!window.confirm("取消这个待支付订单？")) return;
      event.currentTarget.disabled = true;
      try {
        await apiRequest(`/orders/${orderId}/cancel`, { method: "POST" });
        state.orders = (await apiRequest("/orders")).orders || state.orders;
        showToast("订单已取消");
        render();
      } catch (error) {
        showToast(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-select-payment-method]").forEach((button) => {
    button.addEventListener("click", (event) => {
      state.selectedPaymentMethod = event.currentTarget.dataset.selectPaymentMethod || "";
      render();
    });
  });
  document.querySelectorAll("[data-submit-payment]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const orderId = event.currentTarget.dataset.submitPayment;
      const order = state.orders.find((item) => item.id === orderId);
      const method = state.selectedPaymentMethod || order?.paymentSubmission?.method || state.paymentConfig?.methods?.[0]?.id || "";
      if (!method) return showToast("请先选择支付方式");
      const reference = window.prompt("请输入支付流水号、交易号或付款备注", order?.paymentSubmission?.reference || "");
      if (reference === null) return;
      if (reference.trim().length < 3) return showToast("请填写至少 3 个字符的付款流水号");
      const note = window.prompt("补充说明（可选，例如付款姓名或时间）", order?.paymentSubmission?.note || "");
      if (note === null) return;
      event.currentTarget.disabled = true;
      try {
        await apiRequest(`/orders/${encodeURIComponent(orderId)}/payment-submission`, { method: "POST", body: { method, reference, note } });
        state.orders = (await apiRequest("/orders")).orders || state.orders;
        showToast("付款信息已提交，等待后台核验");
        render();
      } catch (error) {
        showToast(error.message);
        event.currentTarget.disabled = false;
      }
    });
  });
  document.querySelector("#refresh-orders")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await loadRemoteState();
      showToast("订单状态已刷新");
    } catch (error) {
      showToast(error.message);
      event.currentTarget.disabled = false;
    }
  });
}

async function copyLink(type) {
  const links = subLinks();
  if (!links[type]) return showToast(t("noSubscription"));
  const copied = await copyText(links[type]);
  showToast(copied ? t("copied") : "复制失败，请长按链接复制");
}

async function copyText(value) {
  if (!value) return false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the legacy clipboard path for local HTTP testing.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  textarea.remove();
  return copied;
}

async function syncSubscription() {
  try {
    const result = await apiRequest("/subscription/sync", { method: "POST" });
    state.subscription = result.subscription;
    state.plan = result.subscription.plan;
    state.usage = await apiRequest("/usage");
    state.usageHistory = (await apiRequest("/usage/history")).history || state.usageHistory;
    state.orders = (await apiRequest("/orders")).orders || state.orders;
    showToast(t("synced"));
    render();
  } catch (error) { showToast(error.message); }
}

async function resetSubscription() {
  try {
    const result = await apiRequest("/subscription/reset", { method: "POST" });
    state.subscription = result.subscription;
    state.plan = result.subscription.plan;
    showToast(t("reset"));
    render();
  } catch (error) { showToast(error.message); }
}

function clientRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Idempotency only needs a practically unique client key; this fallback
  // keeps HTTP/LAN browsers able to place orders when Web Crypto is absent.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function buyPlan(planId = state.subscription?.plan?.id || state.plans[0]?.id) {
  if (buyInFlight) return;
  buyInFlight = true;
  try {
    const renewal = hasActiveSubscription();
    const idempotencyKey = clientRequestId();
    const orderRequest = () => apiRequest("/orders", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: { planId, renewal } });
    let order;
    try {
      order = await orderRequest();
    } catch (error) {
      if (error.code !== "REQUEST_TIMEOUT") throw error;
      order = await orderRequest();
    }
    if (state.paymentMode !== "mock") {
      state.orders = (await apiRequest("/orders")).orders || state.orders;
      state.view = "billing";
      showToast(t("orderPending"));
      render();
      return;
    }
    const result = await apiRequest(`/orders/${order.order.id}/confirm`, { method: "POST" });
    state.subscription = result.subscription;
    state.plan = result.subscription.plan;
    state.usage = await apiRequest("/usage");
    state.usageHistory = (await apiRequest("/usage/history")).history || state.usageHistory;
    state.orders = (await apiRequest("/orders")).orders || state.orders;
    showToast(renewal ? t("renewalCreated") : t("orderCreated"));
    state.view = "overview";
    render();
  } catch (error) { showToast(error.message); }
  finally { buyInFlight = false; }
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

applyDocumentLanguage();
async function bootClient() {
  try {
    const response = await fetch(`${API_BASE}/config`);
    const config = await response.json().catch(() => ({}));
    state.demoEnabled = Boolean(config.demoAccount);
  } catch { /* The auth screen remains usable when the API is temporarily offline. */ }
  startRemoteRefresh();
  await loadRemoteState();
}

if (isAdminRoute()) loadAdminState();
else bootClient();
