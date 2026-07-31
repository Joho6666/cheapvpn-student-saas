// CheapVPN / StudentShield Interactive Application Logic

// Global State
const appState = {
  currentPage: 'home',
  currentLang: 'en',
  theme: 'light',
  isLoggedIn: true,
  user: {
    name: 'Chen Wei',
    email: 'chen.wei@student.edu',
    plan: 'Student Standard',
    expiresOn: '2025-01-20',
    dataUsedGB: 85,
    dataTotalGB: 120,
    resetDays: 12,
    referralCode: 'STUDENT2024',
    referralLink: 'https://cheapvpn.com/ref/STUDENT2024',
    availableCredit: 45.0,
    totalReferrals: 12
  },
  vpn: {
    isConnected: false,
    isConnecting: false,
    selectedServer: {
      id: 'hk-4',
      name: 'Hong Kong Server #4',
      flag: '🇭🇰',
      location: 'Hong Kong',
      latencyMs: 18,
      pingBars: 4,
      load: '32%'
    },
    protocol: 'WireGuard (Fastest)',
    downloadSpeedMbps: 0,
    uploadSpeedMbps: 0,
    connectedTimeSeconds: 0,
    timerInterval: null
  },
  servers: [
    { id: 'hk-4', name: 'Hong Kong Server #4', flag: '🇭🇰', location: 'Hong Kong', latencyMs: 18, pingBars: 4, load: '32%', tag: 'Edu Fast' },
    { id: 'sg-2', name: 'Singapore - Edu Network #2', flag: '🇸🇬', location: 'Singapore', latencyMs: 24, pingBars: 4, load: '45%', tag: 'Streaming' },
    { id: 'tokyo-1', name: 'Tokyo Server #1', flag: '🇯🇵', location: 'Japan', latencyMs: 38, pingBars: 3, load: '58%', tag: 'Gaming' },
    { id: 'us-west-3', name: 'US West (Los Angeles) #3', flag: '🇺🇸', location: 'United States', latencyMs: 135, pingBars: 3, load: '22%', tag: 'Academic' },
    { id: 'uk-london-1', name: 'UK London Campus #1', flag: '🇬🇧', location: 'United Kingdom', latencyMs: 165, pingBars: 2, load: '19%', tag: 'Library' }
  ],
  tickets: [
    { id: '#TKT-1042', subject: 'Cannot connect to Japan servers', status: 'Closed', date: 'Oct 12, 2024', category: 'Connection' },
    { id: '#TKT-0988', subject: 'Refund request for double charge', status: 'Pending', date: 'Sep 28, 2024', category: 'Billing' }
  ],
  devices: [
    { id: 1, name: 'Windows Laptop (Dell XPS)', type: 'desktop_windows', lastActive: 'Currently Active', ip: '192.168.1.104' },
    { id: 2, name: 'iPhone 15 Pro (iOS 17)', type: 'phone_iphone', lastActive: '2 hours ago', ip: '10.0.0.12' },
    { id: 3, name: 'iPad Air (macOS/iPadOS)', type: 'tablet_mac', lastActive: 'Yesterday', ip: '10.0.0.18' }
  ]
};

// Translations Dictionary
const i18n = {
  en: {
    brand: "CheapVPN",
    home: "Home",
    pricing: "Pricing",
    support: "Support",
    setupGuide: "Setup Guide",
    referrals: "Referrals",
    dashboard: "Dashboard",
    settings: "Settings",
    signIn: "Sign In",
    signUp: "Sign Up",
    welcome: "Welcome back, Student!",
    welcomeSub: "Manage your connection and account details below.",
    subActive: "Subscription: Active",
    currentPlan: "Current Plan",
    planName: "Student Standard",
    expiresOn: "Expires On",
    renewPlan: "Renew Plan",
    dataUsage: "Data Usage",
    of: "of",
    resetsIn: "Resets in 12 days",
    connect: "Connect",
    disconnect: "Disconnect",
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Disconnected",
    secureConnection: "Secure Connection",
    hkServer: "Hong Kong Server #4",
    quickActions: "Quick Connect Actions",
    copySubUrl: "Copy Sub URL",
    showQrCode: "Show QR Code",
    liveSupport: "Live Support",
    announcements: "Announcements",
    whyStudentsLoveUs: "Why Students Love Us",
    highSpeed: "High-Speed Connectivity",
    simpleSetup: "Simple Setup",
    support247: "24/7 Support",
    digitalInclusion: "Digital Inclusion First",
    supportHeader: "How can we help you today?"
  },
  zh: {
    brand: "CheapVPN 极速加速器",
    home: "首页",
    pricing: "套餐价格",
    support: "帮助支持",
    setupGuide: "使用教程",
    referrals: "邀请返利",
    dashboard: "控制台",
    settings: "账号设置",
    signIn: "登录账号",
    signUp: "免费注册",
    welcome: "欢迎回来，留学生同学！",
    welcomeSub: "随时管理您的网络连接与账号信息。",
    subActive: "订阅状态：已生效",
    currentPlan: "当前套餐",
    planName: "留学生标准版",
    expiresOn: "到期时间",
    renewPlan: "续费套餐",
    dataUsage: "本月已用流量",
    of: "/",
    resetsIn: "距离重置还有 12 天",
    connect: "一键连接",
    disconnect: "断开连接",
    connecting: "正在安全连接中...",
    connected: "安全保护中",
    disconnected: "未连接",
    secureConnection: "加密网络连接",
    hkServer: "香港高质节点 #4",
    quickActions: "快捷操作",
    copySubUrl: "复制订阅链接",
    showQrCode: "显示二维码",
    liveSupport: "在线客服",
    announcements: "最新公告",
    whyStudentsLoveUs: "为什么留学生首选 CheapVPN",
    highSpeed: "极速网络无卡顿",
    simpleSetup: "小白式一键配置",
    support247: "24小时专属客服",
    digitalInclusion: "无障碍全球学术连接",
    supportHeader: "今天有什么我们可以帮您的？"
  },
  ar: {
    brand: "CheapVPN",
    home: "الرئيسية",
    pricing: "الأسعار",
    support: "الدعم",
    setupGuide: "دليل الإعداد",
    referrals: "الإحالات",
    dashboard: "لوحة التحكم",
    settings: "الإعدادات",
    signIn: "تسجيل الدخول",
    signUp: "إنشاء حساب",
    welcome: "مرحباً بك مجدداً، أيها الطالب!",
    welcomeSub: "إدارة الاتصال وتفاصيل حسابك أدناه.",
    subActive: "الاشتراك: نشط",
    currentPlan: "الخطة الحالية",
    planName: "القياسية للطلاب",
    expiresOn: "ينتهي في",
    renewPlan: "تجديد الخطة",
    dataUsage: "استخدام البيانات",
    of: "من",
    resetsIn: "إعادة التعيين خلال 12 يوماً",
    connect: "اتصال",
    disconnect: "قطع الاتصال",
    connecting: "جاري الاتصال...",
    connected: "متصل بأمان",
    disconnected: "غير متصل",
    secureConnection: "اتصال آمن",
    hkServer: "خادم هونغ كونغ #4",
    quickActions: "إجراءات سريعة",
    copySubUrl: "نسخ رابط الاشتراك",
    showQrCode: "عرض رمز QR",
    liveSupport: "الدعم المباشر",
    announcements: "الإعلانات الأخيرة",
    whyStudentsLoveUs: "لماذا يفضلنا الطلاب",
    highSpeed: "اتصال عالي السرعة",
    simpleSetup: "إعداد بسيط",
    support247: "دعم على مدار 24/7",
    digitalInclusion: "الربط الرقمي الشامل",
    supportHeader: "كيف يمكننا مساعدتك اليوم؟"
  },
  fr: {
    brand: "CheapVPN",
    home: "Accueil",
    pricing: "Tarifs",
    support: "Support",
    setupGuide: "Guide de configuration",
    referrals: "Parrainage",
    dashboard: "Tableau de bord",
    settings: "Paramètres",
    signIn: "Connexion",
    signUp: "S'inscrire",
    welcome: "Bienvenue, Étudiant !",
    welcomeSub: "Gérez votre connexion et vos informations de compte ci-dessous.",
    subActive: "Abonnement : Actif",
    currentPlan: "Forfait actuel",
    planName: "Étudiant Standard",
    expiresOn: "Expire le",
    renewPlan: "Renouveler",
    dataUsage: "Données utilisées",
    of: "sur",
    resetsIn: "Réinitialisation dans 12 jours",
    connect: "Connecter",
    disconnect: "Déconnecter",
    connecting: "Connexion en cours...",
    connected: "Connecté et sécurisé",
    disconnected: "Déconnecté",
    secureConnection: "Connexion sécurisée",
    hkServer: "Serveur Hong Kong #4",
    quickActions: "Actions rapides",
    copySubUrl: "Copier le lien",
    showQrCode: "Code QR",
    liveSupport: "Support en direct",
    announcements: "Annonces récentes",
    whyStudentsLoveUs: "Pourquoi les étudiants nous adorent",
    highSpeed: "Connexion haute vitesse",
    simpleSetup: "Configuration simple",
    support247: "Support 24/7",
    digitalInclusion: "Inclusion numérique",
    supportHeader: "Comment pouvons-nous vous aider aujourd'hui ?"
  }
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupLanguageSwitcher();
  setupThemeToggle();
  setupVPNWidget();
  setupModals();
  setupOSGuideTabs();
  setupReferralCopy();
  setupSupportSearch();
  setupSettingsForms();
  renderServerList();
  renderDevicesList();
  renderTicketsList();
  updateDataGauge();
});

// Toast System
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast border-l-4 ${
    type === 'success' ? 'border-l-emerald-500' : type === 'error' ? 'border-l-rose-500' : 'border-l-primary'
  }`;
  const icon = type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info';
  toast.innerHTML = `
    <span class="material-symbols-outlined text-${type === 'success' ? 'emerald' : type === 'error' ? 'rose' : 'primary'}-600">${icon}</span>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Navigation Logic
function setupNavigation() {
  const navLinks = document.querySelectorAll('[data-target]');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const pageId = link.getAttribute('data-target');
      navigateTo(pageId);
    });
  });
}

function navigateTo(pageId) {
  const views = document.querySelectorAll('.page-view');
  let targetFound = false;

  views.forEach(view => {
    if (view.id === `page-${pageId}`) {
      view.classList.add('active');
      targetFound = true;
    } else {
      view.classList.remove('active');
    }
  });

  if (targetFound) {
    appState.currentPage = pageId;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Update active nav styling
    document.querySelectorAll('[data-target]').forEach(el => {
      if (el.getAttribute('data-target') === pageId) {
        el.classList.add('text-primary', 'font-bold');
        el.classList.remove('text-on-surface-variant');
      } else {
        el.classList.remove('text-primary', 'font-bold');
        el.classList.add('text-on-surface-variant');
      }
    });
  }
}

// i18n Language Switcher
function setupLanguageSwitcher() {
  const langSelect = document.getElementById('global-lang-select');
  if (!langSelect) return;

  langSelect.addEventListener('change', (e) => {
    const lang = e.target.value;
    appState.currentLang = lang;
    
    // Check RTL for Arabic
    if (lang === 'ar') {
      document.documentElement.setAttribute('dir', 'rtl');
      document.documentElement.setAttribute('lang', 'ar');
    } else {
      document.documentElement.setAttribute('dir', 'ltr');
      document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : lang);
    }

    updateI18nTexts();
    showToast(`Language switched to ${langSelect.options[langSelect.selectedIndex].text}`, 'success');
  });
}

function updateI18nTexts() {
  const langObj = i18n[appState.currentLang] || i18n.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (langObj[key]) {
      el.textContent = langObj[key];
    }
  });
}

// Theme Toggle
function setupThemeToggle() {
  const themeBtn = document.getElementById('theme-toggle-btn');
  if (!themeBtn) return;

  themeBtn.addEventListener('click', () => {
    if (appState.theme === 'light') {
      appState.theme = 'dark';
      document.documentElement.classList.add('dark');
      themeBtn.querySelector('span').textContent = 'light_mode';
      showToast('Switched to Dark Mode', 'info');
    } else {
      appState.theme = 'light';
      document.documentElement.classList.remove('dark');
      themeBtn.querySelector('span').textContent = 'dark_mode';
      showToast('Switched to Light Mode', 'info');
    }
  });
}

// VPN Connection Widget Logic
function setupVPNWidget() {
  const connectButtons = document.querySelectorAll('.vpn-toggle-btn');
  connectButtons.forEach(btn => {
    btn.addEventListener('click', toggleVPNConnection);
  });
}

function toggleVPNConnection() {
  const vpn = appState.vpn;
  
  if (vpn.isConnecting) return;

  if (vpn.isConnected) {
    // Disconnect
    vpn.isConnected = false;
    vpn.isConnecting = false;
    clearInterval(vpn.timerInterval);
    vpn.timerInterval = null;
    updateVPNUI();
    showToast('VPN Disconnected', 'info');
  } else {
    // Connect
    vpn.isConnecting = true;
    updateVPNUI();

    setTimeout(() => {
      vpn.isConnecting = false;
      vpn.isConnected = true;
      vpn.connectedTimeSeconds = 0;

      // Speed simulation timer
      vpn.timerInterval = setInterval(() => {
        vpn.connectedTimeSeconds++;
        vpn.downloadSpeedMbps = (35 + Math.random() * 25).toFixed(1);
        vpn.uploadSpeedMbps = (12 + Math.random() * 10).toFixed(1);
        updateVPNSpeedStats();
      }, 1000);

      updateVPNUI();
      showToast(`Connected to ${vpn.selectedServer.name}!`, 'success');
    }, 1200);
  }
}

function updateVPNUI() {
  const vpn = appState.vpn;

  // Status badges & text
  const statusTexts = document.querySelectorAll('.vpn-status-text');
  const statusPills = document.querySelectorAll('.vpn-status-pill');
  const toggleBtns = document.querySelectorAll('.vpn-toggle-btn');
  const serverNameDisplays = document.querySelectorAll('.vpn-server-display');

  statusTexts.forEach(el => {
    if (vpn.isConnecting) {
      el.textContent = 'Connecting...';
      el.className = 'vpn-status-text font-bold text-amber-500';
    } else if (vpn.isConnected) {
      el.textContent = 'Connected & Encrypted';
      el.className = 'vpn-status-text font-bold text-emerald-600 dark:text-emerald-400';
    } else {
      el.textContent = 'Disconnected';
      el.className = 'vpn-status-text font-bold text-on-surface-variant';
    }
  });

  statusPills.forEach(pill => {
    if (vpn.isConnected) {
      pill.className = 'flex items-center gap-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 px-3 py-1 rounded-full text-xs font-semibold';
      pill.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span> Protected`;
    } else if (vpn.isConnecting) {
      pill.className = 'flex items-center gap-2 bg-amber-500/10 text-amber-600 border border-amber-500/30 px-3 py-1 rounded-full text-xs font-semibold';
      pill.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500 animate-spin"></span> Connecting`;
    } else {
      pill.className = 'flex items-center gap-2 bg-surface-container-high text-on-surface-variant px-3 py-1 rounded-full text-xs font-semibold';
      pill.innerHTML = `<span class="w-2 h-2 rounded-full bg-gray-400"></span> Unprotected`;
    }
  });

  toggleBtns.forEach(btn => {
    if (vpn.isConnecting) {
      btn.innerHTML = `<span class="material-symbols-outlined animate-spin text-2xl">sync</span> Connecting...`;
      btn.className = 'vpn-toggle-btn w-full py-4 rounded-xl font-bold bg-amber-500 text-white shadow-lg transition-all';
    } else if (vpn.isConnected) {
      btn.innerHTML = `<span class="material-symbols-outlined text-2xl">power_settings_new</span> Disconnect`;
      btn.className = 'vpn-toggle-btn w-full py-4 rounded-xl font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-lg shadow-rose-500/20 transition-all';
    } else {
      btn.innerHTML = `<span class="material-symbols-outlined text-2xl">power_settings_new</span> Connect Now`;
      btn.className = 'vpn-toggle-btn w-full py-4 rounded-xl font-bold bg-primary hover:bg-primary-container text-white shadow-lg shadow-primary/25 transition-all pulse-connect';
    }
  });

  serverNameDisplays.forEach(el => {
    el.textContent = vpn.selectedServer.name;
  });
}

function updateVPNSpeedStats() {
  const dlEl = document.getElementById('vpn-download-stat');
  const ulEl = document.getElementById('vpn-upload-stat');
  const timeEl = document.getElementById('vpn-timer-stat');

  if (dlEl) dlEl.textContent = `${appState.vpn.downloadSpeedMbps} Mbps`;
  if (ulEl) ulEl.textContent = `${appState.vpn.uploadSpeedMbps} Mbps`;
  if (timeEl) {
    const s = appState.vpn.connectedTimeSeconds;
    const mins = Math.floor(s / 60).toString().padStart(2, '0');
    const secs = (s % 60).toString().padStart(2, '0');
    timeEl.textContent = `${mins}:${secs}`;
  }
}

// Render Server List Modal & Selector
function renderServerList() {
  const container = document.getElementById('server-list-container');
  if (!container) return;

  container.innerHTML = '';
  appState.servers.forEach(srv => {
    const isSelected = srv.id === appState.vpn.selectedServer.id;
    const item = document.createElement('div');
    item.className = `flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
      isSelected ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-outline-variant/40 hover:bg-surface-container-low'
    }`;
    item.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="text-2xl">${srv.flag}</span>
        <div>
          <div class="font-semibold text-sm text-on-surface flex items-center gap-2">
            ${srv.name}
            <span class="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary font-medium">${srv.tag}</span>
          </div>
          <div class="text-xs text-on-surface-variant">${srv.location} • Load: ${srv.load}</div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs font-mono font-medium text-emerald-600 dark:text-emerald-400">${srv.latencyMs} ms</span>
        <button class="px-3 py-1.5 rounded-lg text-xs font-semibold ${
          isSelected ? 'bg-primary text-white' : 'bg-surface-container text-on-surface hover:bg-surface-container-high'
        }">
          ${isSelected ? 'Selected' : 'Connect'}
        </button>
      </div>
    `;
    item.addEventListener('click', () => {
      appState.vpn.selectedServer = srv;
      renderServerList();
      updateVPNUI();
      closeModal('modal-server-select');
      showToast(`Selected server: ${srv.name}`, 'info');
      if (appState.vpn.isConnected) {
        showToast('Re-connecting to new server...', 'info');
        toggleVPNConnection(); // reconnect
        setTimeout(() => toggleVPNConnection(), 300);
      }
    });
    container.appendChild(item);
  });
}

// Data Usage Gauge Update
function updateDataGauge() {
  const circle = document.getElementById('data-gauge-circle');
  const percentageEl = document.getElementById('data-gauge-percentage');
  if (!circle || !percentageEl) return;

  const used = appState.user.dataUsedGB;
  const total = appState.user.dataTotalGB;
  const pct = Math.round((used / total) * 100);

  // Circumference of r=40 is 251.2
  const circumference = 251.2;
  const offset = circumference - (pct / 100) * circumference;

  circle.style.strokeDashoffset = offset;
  percentageEl.textContent = `${used}GB`;
}

// OS Setup Guide Tabs
function setupOSGuideTabs() {
  const tabs = document.querySelectorAll('.os-tab-btn');
  const guides = document.querySelectorAll('.os-guide-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const os = tab.getAttribute('data-os');
      tabs.forEach(t => {
        if (t === tab) {
          t.className = 'os-tab-btn flex-1 min-w-[110px] py-3 px-4 rounded-xl bg-primary text-white font-semibold text-sm transition-all shadow-sm';
        } else {
          t.className = 'os-tab-btn flex-1 min-w-[110px] py-3 px-4 rounded-xl text-on-surface-variant hover:bg-surface-container-low font-semibold text-sm transition-all';
        }
      });

      guides.forEach(g => {
        if (g.id === `guide-${os}`) {
          g.classList.remove('hidden');
        } else {
          g.classList.add('hidden');
        }
      });
    });
  });
}

// Referral Code Copy
function setupReferralCopy() {
  const copyBtn = document.getElementById('btn-copy-ref-link');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(appState.user.referralLink).then(() => {
        showToast('Referral link copied to clipboard!', 'success');
      }).catch(() => {
        showToast('Copied: ' + appState.user.referralLink, 'success');
      });
    });
  }

  const copyCodeBtn = document.getElementById('btn-copy-ref-code');
  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(appState.user.referralCode).then(() => {
        showToast('Referral code STUDENT2024 copied!', 'success');
      });
    });
  }

  const copySubBtn = document.getElementById('btn-copy-sub-url');
  if (copySubBtn) {
    copySubBtn.addEventListener('click', () => {
      const subUrl = 'cheapvpn://connect?token=stu_89fa2bc8371900129';
      navigator.clipboard.writeText(subUrl).then(() => {
        showToast('Subscription URL copied to clipboard!', 'success');
      });
    });
  }
}

// Support Search & Diagnostics Simulation
function setupSupportSearch() {
  const searchInput = document.getElementById('support-search-input');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    const articles = document.querySelectorAll('.faq-article-card');
    articles.forEach(card => {
      const text = card.textContent.toLowerCase();
      if (!q || text.includes(q)) {
        card.style.display = 'block';
      } else {
        card.style.display = 'none';
      }
    });
  });
}

window.runNetworkDiagnostics = function() {
  openModal('modal-diagnostics');
  const logContainer = document.getElementById('diag-log-container');
  const progressCircle = document.getElementById('diag-progress-bar');
  if (!logContainer) return;

  logContainer.innerHTML = '';
  const steps = [
    { text: 'Checking local network interface...', delay: 500, status: 'OK' },
    { text: 'Resolving DNS for edu.cheapvpn.net...', delay: 1100, status: 'OK (104.28.14.9)' },
    { text: 'Testing ping to Hong Kong Server #4...', delay: 1800, status: '18ms' },
    { text: 'Verifying WireGuard SSL handshake...', delay: 2500, status: 'PASSED' },
    { text: 'Auditing MTU packet fragmentation...', delay: 3100, status: 'OPTIMAL (1420)' }
  ];

  let current = 0;
  steps.forEach((step, idx) => {
    setTimeout(() => {
      const line = document.createElement('div');
      line.className = 'flex justify-between items-center py-1.5 border-b border-outline-variant/20 text-xs font-mono';
      line.innerHTML = `
        <span class="text-on-surface">${step.text}</span>
        <span class="text-emerald-500 font-bold">${step.status}</span>
      `;
      logContainer.appendChild(line);
      current++;

      if (progressCircle) {
        progressCircle.style.width = `${(current / steps.length) * 100}%`;
      }

      if (current === steps.length) {
        showToast('Network diagnosis completed: All systems healthy!', 'success');
      }
    }, step.delay);
  });
};

// Render Devices List
function renderDevicesList() {
  const container = document.getElementById('settings-devices-list');
  if (!container) return;

  container.innerHTML = '';
  appState.devices.forEach(dev => {
    const card = document.createElement('div');
    card.className = 'flex items-center justify-between p-4 rounded-xl border border-outline-variant/40 bg-surface-container-lowest';
    card.innerHTML = `
      <div class="flex items-center gap-4">
        <div class="p-3 bg-primary/10 text-primary rounded-xl">
          <span class="material-symbols-outlined">${dev.type}</span>
        </div>
        <div>
          <h4 class="font-bold text-sm text-on-surface">${dev.name}</h4>
          <p class="text-xs text-on-surface-variant">IP: ${dev.ip} • ${dev.lastActive}</p>
        </div>
      </div>
      <button onclick="removeDevice(${dev.id})" class="px-3 py-1.5 rounded-lg text-xs font-medium text-rose-600 border border-rose-200 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
        Disconnect
      </button>
    `;
    container.appendChild(card);
  });
}

window.removeDevice = function(id) {
  appState.devices = appState.devices.filter(d => d.id !== id);
  renderDevicesList();
  showToast('Device disconnected successfully', 'success');
};

// Render Ticket History
function renderTicketsList() {
  const container = document.getElementById('support-tickets-list');
  if (!container) return;

  container.innerHTML = '';
  appState.tickets.forEach(tkt => {
    const div = document.createElement('div');
    div.className = 'p-4 rounded-xl bg-surface hover:bg-surface-container-low border border-outline-variant/30 transition-colors cursor-pointer';
    div.innerHTML = `
      <div class="flex justify-between items-start mb-2">
        <span class="font-bold text-xs text-primary">${tkt.id}</span>
        <span class="text-[10px] px-2 py-0.5 rounded-full font-semibold ${
          tkt.status === 'Closed' ? 'bg-surface-variant text-on-surface-variant' : 'bg-amber-500/10 text-amber-600'
        }">${tkt.status}</span>
      </div>
      <p class="font-semibold text-sm text-on-surface truncate">${tkt.subject}</p>
      <p class="text-xs text-on-surface-variant mt-1">${tkt.date} • ${tkt.category}</p>
    `;
    container.appendChild(div);
  });
}

// Settings Forms
function setupSettingsForms() {
  const profileForm = document.getElementById('form-profile-settings');
  if (profileForm) {
    profileForm.addEventListener('submit', (e) => {
      e.preventDefault();
      showToast('Profile updated successfully!', 'success');
    });
  }
}

// Modal Helpers
function setupModals() {
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.closest('.modal-overlay').id;
      closeModal(modalId);
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal(overlay.id);
      }
    });
  });
}

window.openModal = function(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
};

window.closeModal = function(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};

// Global helper for opening QR Code Modal
window.openQrModal = function() {
  openModal('modal-qr-code');
};

// Global helper for opening Checkout Modal
window.openCheckoutModal = function(planName, price) {
  const planEl = document.getElementById('checkout-plan-name');
  const priceEl = document.getElementById('checkout-plan-price');
  if (planEl) planEl.textContent = planName;
  if (priceEl) priceEl.textContent = price;
  openModal('modal-checkout');
};

// Global helper for Live Chat Drawer
window.toggleLiveChat = function() {
  const drawer = document.getElementById('live-chat-drawer');
  if (drawer) {
    drawer.classList.toggle('translate-x-full');
  }
};

window.sendChatMessage = function() {
  const input = document.getElementById('chat-input-text');
  const body = document.getElementById('chat-messages-body');
  if (!input || !body || !input.value.trim()) return;

  const msg = input.value.trim();
  input.value = '';

  // Append user msg
  const userBubble = document.createElement('div');
  userBubble.className = 'self-end bg-primary text-white p-3 rounded-2xl rounded-tr-none text-sm max-w-[80%] shadow-sm';
  userBubble.textContent = msg;
  body.appendChild(userBubble);
  body.scrollTop = body.scrollHeight;

  // Bot response after 800ms
  setTimeout(() => {
    const botBubble = document.createElement('div');
    botBubble.className = 'self-start bg-surface-container-high text-on-surface p-3 rounded-2xl rounded-tl-none text-sm max-w-[80%] shadow-sm';
    botBubble.textContent = `Thanks for reaching out! Our 24/7 student support team has received: "${msg}". A technical specialist is connected to assist you.`;
    body.appendChild(botBubble);
    body.scrollTop = body.scrollHeight;
  }, 800);
};
