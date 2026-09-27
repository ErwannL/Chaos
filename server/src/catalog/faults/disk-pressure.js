import { ROLES } from '../../targets.js';
import { ChaosError } from '../../errors.js';

const FILE = '.chaos-disk-pressure';

/** Parses `df -Pk` output: returns { totalKb, usedKb }. */
export function parseDf(output) {
  const line = output.trim().split('\n').pop().trim().split(/\s+/);
  const totalKb = Number(line[1]);
  const usedKb = Number(line[2]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || totalKb <= 0) {
    throw new ChaosError('DISK_UNKNOWN', `Cannot parse df output: ${output.slice(0, 120)}`, 500);
  }
  return { totalKb, usedKb };
}

export default {
  key: 'disk_pressure',
  kind: 'container',
  title: { fr: 'Saturation disque', en: 'Disk pressure' },
  description: {
    fr: 'Remplit le volume déclaré (diskPath) jusqu’à un seuil borné, puis supprime le fichier.',
    en: 'Fills the declared volume (diskPath) up to a bounded threshold, then deletes the file.',
  },
  roles: ROLES,
  requires: ['diskPath'],
  maxDurationS: 300,
  params: {
    targetPercent: { type: 'integer', min: 50, max: 95, default: 90, unit: '%' },
    maxMb: { type: 'integer', min: 1, max: 4096, default: 256, unit: 'MB' },
  },
  async inject(ctx, params) {
    const { docker } = ctx;
    const id = await docker.containerFor(ctx.service.name);
    const file = `${ctx.service.diskPath}/${FILE}`;
    const df = await docker.exec(id, ['df', '-Pk', ctx.service.diskPath]);
    if (df.exitCode !== 0) throw new ChaosError('DISK_UNKNOWN', `df failed: ${df.output}`, 500);
    const { totalKb, usedKb } = parseDf(df.output);
    const wantKb = Math.floor((totalKb * params.targetPercent) / 100) - usedKb;
    const mb = Math.max(0, Math.min(params.maxMb, Math.floor(wantKb / 1024)));
    const state = { id, file, mb };
    await ctx.checkpoint(state);
    if (mb > 0) {
      const res = await docker.exec(id, [
        'dd',
        'if=/dev/zero',
        `of=${file}`,
        'bs=1048576',
        `count=${mb}`,
      ]);
      if (res.exitCode !== 0) throw new ChaosError('DISK_FILL_FAILED', res.output, 500);
    }
    return state;
  },
  async revert(ctx, state) {
    const id = state?.id ?? (await ctx.docker.containerFor(ctx.service.name));
    const file = state?.file ?? `${ctx.service.diskPath}/${FILE}`;
    const res = await ctx.docker.exec(id, ['rm', '-f', file]);
    if (res.exitCode !== 0) throw new ChaosError('DISK_CLEAN_FAILED', res.output, 500);
  },
};
