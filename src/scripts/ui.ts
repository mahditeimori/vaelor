/**
 * Shared UI layer: bilingual copy, scroll motion, close buttons, progress bar.
 * Idempotent — safe to import from every layout.
 */

type Lang = 'fa' | 'en';

const DICT: Record<Lang, Record<string, string>> = {
  fa: {
    'nav.home': 'نمای کلی',
    'nav.dashboard': 'داشبورد مشتری',
    'nav.terminal': 'ترمینال',
    'nav.execution': 'اجرا',
    'nav.docs': 'مستندات',
    'nav.news': 'اخبار',
    'nav.ai': 'هوش مصنوعی',
    'nav.signin': 'ورود / ثبت نام',
    'nav.openAccount': 'ورود به حساب',
    'hero.tag': 'محیط عملیاتی · Vaelor Trading',
    'hero.title1': 'نمای فازی تنظیم‌شده برای',
    'hero.title2': 'موقعیت‌های حیوی',
    'hero.sub': 'دایرکتورهای یکپارچه، قوانین کاغذی کمتر و هر متغیر در یک پنل بصری قابل اشاره — نه فقط متن خام.',
    'hero.search': 'جستجو در سایت…',
    'hero.docs': 'کتاب عملیاتی',
    'hero.terminal': 'ترمینال موقعیت‌ها',
    'promo.title': 'داشبورد مشتری — Member Dashboard',
    'promo.desc': 'خلاصه حساب، پوزیشن‌ها و سیگنال‌های زنده — از داخل سایت، بدون صفحه کپی‌شده.',
    'promo.cta': 'داشبورد مشتری',
    'footer.brand': 'هوش تجاری Vaelor Trading',
    'footer.privacy': 'حریم خصوصی',
    'footer.terms': 'شرایط',
    'md.hello': 'سلام',
    'md.welcome': 'به داشبورد Vaelor خوش آمدید',
    'md.welcomeSub': 'خلاصه حساب، دسترسی زنده و ابزارهای اجرایی شما در یک place.',
    'md.search': 'جستجو…',
    'md.overview': 'نمای کلی',
    'md.accounts': 'حساب‌ها',
    'md.finance': 'مالی',
    'md.signals': 'سیگنال‌ها',
    'md.terminal': 'ترمینال لایو',
    'md.strategy': 'استراتژی‌ها',
    'md.ai': 'هوش مصنوعی',
    'md.news': 'اخبار',
    'md.support': 'پشتیبانی',
    'md.settings': 'تنظیمات',
    'md.signout': 'خروج',
    'md.deposit': 'واریز',
    'md.withdraw': 'برداشت',
    'md.transfer': 'انتقال',
    'md.secure': 'حساب امن',
    'md.verified': 'احراز هویت',
    'md.live': 'زنده',
    'md.positions': 'پوزیشن‌های زنده',
    'md.openSignals': 'سیگنال‌های زنده',
    'md.requests': 'درخواست خرید',
    'md.config': 'پیکربندی',
    'md.features': 'دسترسی به ابزارها',
    'md.case': 'مطالعه مرزی',
    'md.studies': 'مطالعات حالت کلی',
    'md.help': 'نیاز به کمک دارید؟',
    'md.helpSub': 'تیم پشتیبانی آماده است.',
    'md.close': 'بستن',
  },
  en: {
    'nav.home': 'Overview',
    'nav.dashboard': 'Member dashboard',
    'nav.terminal': 'Terminal',
    'nav.execution': 'Execution',
    'nav.docs': 'Docs',
    'nav.news': 'News',
    'nav.ai': 'AI',
    'nav.signin': 'Sign in',
    'nav.openAccount': 'Open account',
    'hero.tag': 'OPERATING ENVIRONMENT · VAELOR TRADING',
    'hero.title1': 'A tuned fuzzy view for',
    'hero.title2': 'live positions',
    'hero.sub': 'Unified directors, less paper-rule overhead, and every variable addressable in one visual panel — not raw text.',
    'hero.search': 'Search the site…',
    'hero.docs': 'Operator manual',
    'hero.terminal': 'Positions terminal',
    'promo.title': 'Member Dashboard',
    'promo.desc': 'Account summary, live positions and signals — inside the site, no copied page.',
    'promo.cta': 'Open dashboard',
    'footer.brand': 'Vaelor Trading Intelligence',
    'footer.privacy': 'Privacy',
    'footer.terms': 'Terms',
    'md.hello': 'Hello',
    'md.welcome': 'Welcome to Vaelor',
    'md.welcomeSub': 'Your account summary, live access and execution tools in one view.',
    'md.search': 'Search…',
    'md.overview': 'Overview',
    'md.accounts': 'Accounts',
    'md.finance': 'Finance',
    'md.signals': 'Signals',
    'md.terminal': 'Live terminal',
    'md.strategy': 'Strategies',
    'md.ai': 'AI desk',
    'md.news': 'News',
    'md.support': 'Support',
    'md.settings': 'Settings',
    'md.signout': 'Sign out',
    'md.deposit': 'Deposit',
    'md.withdraw': 'Withdraw',
    'md.transfer': 'Transfer',
    'md.secure': 'Secure account',
    'md.verified': 'Verified',
    'md.live': 'LIVE',
    'md.positions': 'Live positions',
    'md.openSignals': 'Open signals',
    'md.requests': 'Buy requests',
    'md.config': 'Configuration',
    'md.features': 'Tool access',
    'md.case': 'Borderline case',
    'md.studies': 'General-case studies',
    'md.help': 'Need help?',
    'md.helpSub': 'Our support desk is ready.',
    'md.close': 'Close',
  },
};

const STORAGE_KEY = 'vaelor.lang';

function currentLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'fa';
  } catch {
    return 'fa';
  }
}

function translate(lang: Lang): void {
  const dict = DICT[lang];
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = node.dataset.i18n ?? '';
    if (dict[key]) node.textContent = dict[key];
  }
  for (const node of Array.from(document.querySelectorAll<HTMLInputElement>('[data-i18n-ph]'))) {
    const key = node.dataset.i18nPh ?? '';
    if (dict[key]) node.placeholder = dict[key];
  }
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-lang]'))) {
    node.classList.toggle('is-active', node.dataset.lang === lang);
  }
}

function applyLang(lang: Lang): void {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'fa' ? 'rtl' : 'ltr';
  root.dataset.lang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch { /* storage may be blocked */ }
  translate(lang);
  window.dispatchEvent(new CustomEvent('vaelor:lang', { detail: { lang } }));
}

function mountScrollProgress(): void {
  const bar = document.getElementById('scrollProgress');
  if (!bar || bar.dataset.bound) return;
  bar.dataset.bound = '1';
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0;
    bar.style.width = `${pct}%`;
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
}

function mountReveals(): void {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
  if (!nodes.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    nodes.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  nodes.forEach((el) => io.observe(el));
}

function mountClosers(): void {
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-close]');
    if (!btn) return;
    const selector = btn.dataset.close || '.overlay, [data-modal], #signin-modal, #vaelorFeatureLock';
    const target = btn.closest<HTMLElement>(selector) || document.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.classList.add('hidden');
    target.setAttribute('aria-hidden', 'true');
    if (target.id === 'vaelorFeatureLock') target.remove();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.overlay:not(.hidden), [data-modal]:not(.hidden), #signin-modal:not(.hidden), #vaelorFeatureLock'))) {
      el.classList.add('hidden');
      if (el.id === 'vaelorFeatureLock') el.remove();
    }
  });
}

function mountLangToggles(): void {
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-lang]');
    if (btn) applyLang(btn.dataset.lang === 'en' ? 'en' : 'fa');
  });
}

export function mountUI(): void {
  if (typeof document === 'undefined') return;
  applyLang(currentLang());
  mountLangToggles();
  mountScrollProgress();
  mountReveals();
  mountClosers();
}
