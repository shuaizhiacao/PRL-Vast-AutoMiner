export function profileOf(cfg) {
  return cfg.profiles[cfg.modelProfile];
}

export function parseDiskGb(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/([\d.]+)\s*GB\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function parseVramGb(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const mib = [...text.matchAll(/(\d+)\s*MiB/gi)].map(m => Number(m[1]));
  if (mib.length) return Math.max(...mib) / 1024;
  const lines = text.split(/\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
  if (!lines.length) return null;
  return Math.max(...lines.map(Number)) / 1024;
}

// Clore 的 on_demand 标价是每天。折成美元小时价只用 USD-Blockchain，不猜汇率。
export function hourlyUsd(server) {
  const daily = server?.price?.on_demand?.['USD-Blockchain'];
  if (typeof daily !== 'number' || !Number.isFinite(daily) || daily < 0) return null;
  return daily / 24;
}

export function selectServers(servers, { profile, currency, maxUsdPerHour, rankBy = 'hourly' }) {
  const rows = [];
  for (const server of filterServers(servers, profile, currency)) {
    const hourly = hourlyUsd(server);
    if (hourly == null || hourly > maxUsdPerHour) continue;
    const vram = server.specs.gpuram;
    const h100 = vram > 0 ? hourly / (vram / 80) : Number.POSITIVE_INFINITY;
    rows.push({ server, hourly, h100 });
  }
  const key = rankBy === 'h100' ? 'h100' : 'hourly';
  rows.sort((a, b) => (a[key] - b[key]) || (a.server.id - b.server.id));
  return rows.map(row => row.server);
}

export function filterServers(servers, profile, currency) {
  const picked = [];
  for (const server of servers || []) {
    if (!server || server.rented === true) continue;
    if (server.price?.on_demand?.[currency] == null) continue;
    const vram = server.specs?.gpuram;
    if (typeof vram !== 'number' || vram < profile.minVramGb) continue;
    if (profile.minDiskGb != null) {
      const disk = parseDiskGb(String(server.specs?.disk ?? ''));
      if (disk == null || disk < profile.minDiskGb) continue;
    }
    picked.push(server);
  }
  return picked;
}

export function assessHardware({ smiText, diskText, profile }) {
  const vram = parseVramGb(smiText);
  if (vram == null) return { ok: false, reason: 'nvidia-smi 没有解析出显存' };
  if (vram + 1e-9 < profile.minVramGb) return { ok: false, reason: '实测显存低于档位', vram };
  if (profile.minDiskGb != null) {
    const disk = parseDiskGb(diskText || '');
    if (disk == null) return { ok: false, reason: '没有解析出磁盘容量' };
    if (disk + 1e-9 < profile.minDiskGb) return { ok: false, reason: '实测磁盘低于档位', disk };
    return { ok: true, vram, disk };
  }
  return { ok: true, vram };
}
