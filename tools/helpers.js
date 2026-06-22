// ── 工具函數：常量 + 時間 + 開盤判斷 ──

// ── 各市場本地開盤時間（用時區自動處理 DST）──
const MARKET_HOURS = [
  { code:'JP',    tz:'Asia/Tokyo',       open:'09:00', close:'15:00' },
  { code:'KR',    tz:'Asia/Seoul',       open:'09:00', close:'15:30' },
  // { code:'TW',    tz:'Asia/Taipei',      open:'09:00', close:'13:30' },  // ⏸ 暂时去掉TW统计
  { code:'CN',    tz:'Asia/Shanghai',    open:'09:30', close:'15:00' },
  { code:'HK',    tz:'Asia/Hong_Kong',   open:'09:30', close:'16:00' },
  { code:'SG',    tz:'Asia/Singapore',   open:'09:00', close:'17:00' },
  { code:'AU',    tz:'Australia/Sydney', open:'10:00', close:'16:00' },
  { code:'UK',    tz:'Europe/London',    open:'08:00', close:'16:30' },
  { code:'FR',    tz:'Europe/Paris',     open:'09:00', close:'17:30' },
  { code:'DE',    tz:'Europe/Berlin',    open:'09:00', close:'17:30' },
  { code:'US',    tz:'America/New_York', open:'09:30', close:'16:00' },
  { code:'US_SM', tz:'America/New_York', open:'09:30', close:'16:00' },
];

const ALL_COUNTRIES = ['US','US_SM','UK','FR','DE','JP','KR','CN','HK'];  // ⏸ TW 暂时去掉

const COUNTRY_FLAGS = {
  UK:'🇬🇧',FR:'🇫🇷',DE:'🇩🇪',US:'🇺🇸',US_SM:'🇺🇸',CN:'🇨🇳',
  HK:'🇭🇰',JP:'🇯🇵',KR:'🇰🇷',TW:'🇹🇼',CH:'🇨🇭',NL:'🇳🇱',ES:'🇪🇸',IT:'🇮🇹',AU:'🇦🇺',SG:'🇸🇬'
};

const SECTOR_CN = {
  IT:'科技',FIN:'金融',CD:'可選消費',TELECOM:'通信',IND:'工業',
  CONS:'必需消費',MED:'醫療',ENR:'能源',CHEM:'化工',METAL:'金屬採礦'
};

// ── 時間 ──

function toMinutes(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function getHktTime(atStr) {
  if (atStr) {
    const d = new Date(atStr);
    return { h: d.getHours(), m: d.getMinutes(), ts: d.getTime() };
  }
  const now = new Date(Date.now() + 8 * 3600000);
  return { h: now.getUTCHours(), m: now.getUTCMinutes(), ts: now.getTime() };
}

function getHktDateKey(ts) {
  const d = new Date(ts + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  const hr = d.getUTCHours();
  if (hr < 5) {
    const prev = new Date(d.getTime() - 86400000);
    return `${prev.getUTCFullYear()}${p(prev.getUTCMonth() + 1)}${p(prev.getUTCDate())}`;
  }
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function fmtHkt(ts) {
  const d = new Date(ts + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ── 開盤市場 ──

function getActiveSessions() {
  const now = new Date();
  return MARKET_HOURS.filter(m => {
    const t = now.toLocaleTimeString('en-US', {
      timeZone: m.tz, hour12: false, hour: '2-digit', minute: '2-digit'
    });
    const localMin = toMinutes(t);
    const openMin = toMinutes(m.open);
    const closeMin = toMinutes(m.close);
    if (closeMin <= openMin) return localMin >= openMin || localMin < closeMin;
    return localMin >= openMin && localMin < closeMin;
  }).map(m => m.code);
}

function getActiveMarkets() {
  const codes = getActiveSessions();
  const SESSION_GROUPS = {
    '亞洲時段 (AU)':   ['AU'],
    '亞洲時段 (ASIA)': ['JP','KR','CN','HK','SG'],  // ⏸ TW 暂时去掉
    '歐洲時段':       ['UK','FR','DE'],
    '美國時段':       ['US','US_SM'],
  };
  const groups = [];
  for (const [label, list] of Object.entries(SESSION_GROUPS)) {
    const match = list.filter(c => codes.includes(c));
    if (match.length) groups.push({ id: label, countries: match });
  }
  return { sessions: groups, markets: codes };
}

module.exports = {
  MARKET_HOURS,
  ALL_COUNTRIES,
  COUNTRY_FLAGS,
  SECTOR_CN,
  toMinutes,
  getHktTime,
  getHktDateKey,
  fmtHkt,
  getActiveSessions,
  getActiveMarkets,
};
