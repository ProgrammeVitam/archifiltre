/**
 * Audit report export — generates the French archival "Rapport d'audit" as a .docx.
 *
 * v1 scope: every metric computable today from the scan DB (sizes, counts, depth,
 * CO₂, dates, empty elements, formats-by-category, top oldest/largest, overloaded
 * folders, long paths, old files, problematic characters, FILE duplicates, ROT).
 * Deliberately OUT of v1 (parked): FOLDER duplicates, PRONOM/MIME identification,
 * embedded images (tree screenshot / charts), naming-charter & sensitive-data (AI).
 *
 * French only for the moment (the export menu label says so).
 */
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  ShadingType,
  Footer,
  ExternalHyperlink,
} from 'docx';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '@lib/logging.ts';
import type { PipelineContext } from '@lib/pipeline-context.ts';
import pkg from '../../package.json' with { type: 'json' };

const YEAR_SECONDS = 365.25 * 24 * 3600;
// CO₂ → distance equivalents (indicative, ADEME-style factors, g CO₂e / km). These
// are policy figures the archive service may adjust; surfaced in a report note.
const KM_FACTORS = { voiture: 218, train: 2.3, avion: 230 };
// Thresholds (fixed in v1; user-tunable later).
const OVERLOAD_THRESHOLD = 30;
const LONG_PATH_THRESHOLD = 250;
const RISK_PATH_THRESHOLD = 256;

export interface AuditReportOptions {
  /** Service name for the header (else a placeholder to fill in Word). */
  serviceName?: string;
  /** Tree/arborescence name (else the scanned folder's basename). */
  treeName?: string;
  /** Rows in the "top N" tables. */
  topN?: number;
}

// ── File-type taxonomy (mirrors ui/src/lib/file-types.ts; kept here so the
//    compiled sidecar stays self-contained). Extension → category key. ──
const EXT_CATEGORY: Record<string, string> = {};
const put = (cat: string, exts: string[]) => exts.forEach((e) => (EXT_CATEGORY[e] = cat));
put('document', ['doc', 'docx', 'dot', 'dotm', 'dotx', 'odt', 'ott', 'rtf', 'txt']);
put('spreadsheet', ['csv', 'ods', 'ots', 'xls', 'xlsm', 'xlsx', 'xlt', 'xltm', 'xltx', 'xlw']);
put('presentation', ['odp', 'otp', 'pot', 'pps', 'ppsx', 'ppt', 'pptm', 'pptx']);
put('publication', ['epub', 'mobi', 'pdf']);
put('email', ['eml', 'msg', 'pst']);
put('image', ['bmp', 'gif', 'jp2', 'jpeg', 'jpg', 'png', 'psd', 'svg', 'tif', 'tiff']);
put('video', ['avi', 'mkv', 'mov', 'mp4', 'mpeg', 'wmv']);
put('audio', ['flac', 'mp3', 'ogg', 'rf64', 'wav', 'wma']);
put('compressed', ['zip', 'tar', 'tgz', 'gz', '7z', 'rar', 'warc', 'arc']);
const CAT_LABEL: Record<string, string> = {
  document: 'Documents',
  spreadsheet: 'Tableurs',
  presentation: 'Présentations',
  publication: 'Publications',
  email: 'Courriels',
  image: 'Images',
  video: 'Vidéos',
  audio: 'Audio',
  compressed: 'Fichiers compressés',
  other: 'Autres',
};

// ── Formatting helpers (French) ──
const N = (n: number | bigint) => Number(n).toLocaleString('fr-FR');
const humanSize = (bytes: number | bigint): string => {
  const n = Number(bytes);
  if (n < 1024) return `${n} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(2)} ${units[u]}`;
};
const dateFr = (epochSeconds: number | null): string =>
  epochSeconds ? new Date(Number(epochSeconds) * 1000).toLocaleDateString('fr-FR') : '—';
const co2Grams = (bytes: number | bigint): number => (Number(bytes) / 1024 ** 3) * 11.6;
const co2Str = (grams: number): string =>
  (grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams.toFixed(2)} g`) + ' CO₂e/an';
const basename = (p: string): string => p.split('/').pop() ?? p;

// ── docx building blocks ──
const H = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_2) =>
  new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
const bullet = (text: string, level = 0) => new Paragraph({ text, bullet: { level }, spacing: { after: 40 } });
const runs = (...r: TextRun[]) => new Paragraph({ children: r, spacing: { after: 80 } });
const note = (text: string) =>
  new Paragraph({ children: [new TextRun({ text, italics: true, size: 16, color: '666666' })], spacing: { after: 120 } });
type CellSpec = string | { t: string; color?: string; bold?: boolean };
const cell = (spec: CellSpec, opts: { bold?: boolean; fill?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) => {
  const t = typeof spec === 'string' ? spec : spec.t;
  const color = typeof spec === 'string' ? undefined : spec.color;
  const bold = opts.bold || (typeof spec !== 'string' && spec.bold);
  return new TableCell({
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill, color: 'auto' } : undefined,
    children: [new Paragraph({ alignment: opts.align, children: [new TextRun({ text: t, size: 18, bold, color })] })],
  });
};
const table = (headers: string[], rows: CellSpec[][], columnWidths?: number[]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h) => cell(h, { bold: true, fill: 'EFEFEF' })) }),
      ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
    ],
  });

interface Row {
  [k: string]: unknown;
}

/**
 * Compute all v1 audit metrics and write the .docx. Returns the number of files analysed.
 */
export async function exportToAuditDocx(
  context: PipelineContext,
  outputPath: string,
  options: AuditReportOptions = {}
): Promise<number> {
  const runId = context.runId;
  const pg = context.database.pg;
  const topN = options.topN ?? 10;
  const now = Math.floor(Date.now() / 1000);
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await pg.query(sql, params)).rows as Row[];

  const tot = (
    await q(
      `SELECT COALESCE(SUM(physical_size) FILTER (WHERE NOT is_directory),0)::bigint total_size,
              COUNT(*) FILTER (WHERE NOT is_directory) file_count,
              COUNT(*) FILTER (WHERE is_directory) dir_count,
              MIN(mtime) FILTER (WHERE NOT is_directory) min_mtime,
              MAX(mtime) FILTER (WHERE NOT is_directory) max_mtime,
              MAX(length(path)) longest_path_len,
              COUNT(*) FILTER (WHERE length(path) > ${RISK_PATH_THRESHOLD}) paths_over_risk,
              COUNT(*) FILTER (WHERE NOT is_directory AND physical_size = 0) empty_files
       FROM files WHERE run_id = $1`,
      [runId]
    )
  )[0];
  const depth = (
    await q(
      `SELECT MAX(d) max_depth, AVG(d)::float avg_depth FROM
        (SELECT array_length(string_to_array(path,'/'),1) d FROM files WHERE run_id=$1) t`,
      [runId]
    )
  )[0];
  const nFormats = (
    await q(
      `SELECT COUNT(DISTINCT lower(substring(path from '\\.([^./]+)$'))) n
       FROM files WHERE run_id=$1 AND NOT is_directory AND path ~ '\\.[^./]+$'`,
      [runId]
    )
  )[0].n;
  let emptyDirs = 0;
  try {
    emptyDirs = Number(
      (await q(`SELECT COUNT(*) n FROM dir_stats WHERE run_id=$1 AND file_count=0 AND dir_count=0`, [runId]))[0].n
    );
  } catch {
    /* dir_stats not populated */
  }
  const composition = await q(
    `SELECT lower(substring(path from '\\.([^./]+)$')) ext, COUNT(*) c, SUM(physical_size)::bigint sz
     FROM files WHERE run_id=$1 AND NOT is_directory GROUP BY 1`,
    [runId]
  );
  const oldest = await q(
    `SELECT path, mtime, physical_size::bigint sz FROM files WHERE run_id=$1 AND NOT is_directory ORDER BY mtime ASC LIMIT ${topN}`,
    [runId]
  );
  const largest = await q(
    `SELECT path, mtime, physical_size::bigint sz FROM files WHERE run_id=$1 AND NOT is_directory ORDER BY physical_size DESC LIMIT ${topN}`,
    [runId]
  );
  const overloaded = await q(
    `SELECT parent, COUNT(*) c FROM
      (SELECT CASE WHEN path LIKE '%/%' THEN regexp_replace(path,'/[^/]+$','') ELSE '(racine)' END parent
       FROM files WHERE run_id=$1) t
     GROUP BY parent HAVING COUNT(*) > ${OVERLOAD_THRESHOLD} ORDER BY c DESC LIMIT 15`,
    [runId]
  );
  const longPaths = await q(
    `SELECT path, length(path) l FROM files WHERE run_id=$1 AND length(path) > ${LONG_PATH_THRESHOLD} ORDER BY l DESC LIMIT 15`,
    [runId]
  );
  const old = (
    await q(
      `SELECT COUNT(*) FILTER (WHERE mtime < $2) o5, COUNT(*) FILTER (WHERE mtime < $3) o10, COUNT(*) FILTER (WHERE mtime < $4) o20
       FROM files WHERE run_id=$1 AND NOT is_directory`,
      [runId, now - 5 * YEAR_SECONDS, now - 10 * YEAR_SECONDS, now - 20 * YEAR_SECONDS]
    )
  )[0];
  const special = (
    await q(`SELECT COUNT(*) n FROM files WHERE run_id=$1 AND regexp_replace(path,'^.*/','') ~ '[<>:"|?*]'`, [runId])
  )[0].n;
  const dup = (
    await q(
      `SELECT COUNT(*) groups, COALESCE(SUM(sz*(c-1)),0)::bigint wasted, COALESCE(SUM(c-1),0) redundant
       FROM (SELECT hash, COUNT(*) c, MAX(physical_size) sz FROM files
             WHERE run_id=$1 AND NOT is_directory AND hash IS NOT NULL GROUP BY hash HAVING COUNT(*)>1) g`,
      [runId]
    )
  )[0];
  const topDupCount = await q(
    `SELECT MIN(regexp_replace(path,'^.*/','')) name, COUNT(*) c, MAX(physical_size)::bigint sz
     FROM files WHERE run_id=$1 AND NOT is_directory AND hash IS NOT NULL GROUP BY hash HAVING COUNT(*)>1 ORDER BY c DESC LIMIT ${topN}`,
    [runId]
  );
  const topDupVol = await q(
    `SELECT MIN(regexp_replace(path,'^.*/','')) name, COUNT(*) c, MAX(physical_size)::bigint sz,
            (MAX(physical_size)*(COUNT(*)-1))::bigint wasted
     FROM files WHERE run_id=$1 AND NOT is_directory AND hash IS NOT NULL GROUP BY hash HAVING COUNT(*)>1 ORDER BY wasted DESC LIMIT ${topN}`,
    [runId]
  );
  let deleteVol = { v: 0, n: 0 };
  try {
    const r = (
      await q(
        `SELECT COALESCE(SUM(f.physical_size),0)::bigint v, COUNT(*) n FROM files f
         JOIN delete_tags dt ON f.run_id=dt.run_id AND (f.path=dt.path OR starts_with(f.path, dt.path||'/'))
         WHERE f.run_id=$1 AND NOT f.is_directory`,
        [runId]
      )
    )[0];
    deleteVol = { v: Number(r.v), n: Number(r.n) };
  } catch {
    /* delete_tags table absent */
  }

  // Aggregate composition into categories.
  const catAgg = new Map<string, { c: number; sz: number }>();
  for (const r of composition) {
    const ext = (r.ext as string | null) ?? '';
    const cat = EXT_CATEGORY[ext] ?? 'other';
    const cur = catAgg.get(cat) ?? { c: 0, sz: 0 };
    cur.c += Number(r.c);
    cur.sz += Number(r.sz);
    catAgg.set(cat, cur);
  }
  const categories = [...catAgg.entries()]
    .map(([cat, v]) => ({ label: CAT_LABEL[cat] ?? cat, ...v }))
    .sort((a, b) => b.sz - a.sz);

  const totalCO2 = co2Grams(tot.total_size as number);
  const savedCO2 = co2Grams(dup.wasted as number);
  const treeName = options.treeName || basename(context.rootPath) || '(arborescence)';
  const serviceName = options.serviceName || '[NOM DU SERVICE]';
  const version = (pkg as { version?: string }).version ?? '5';

  // ── Build the document ──
  const children: (Paragraph | Table)[] = [];

  // Header
  children.push(new Paragraph({ children: [new TextRun({ text: serviceName.toUpperCase(), bold: true, size: 20, color: '888888' })] }));
  children.push(new Paragraph({ text: `Rapport d'audit de l'arborescence « ${treeName} »`, heading: HeadingLevel.TITLE }));
  if (context.rootPath) children.push(note(`Chemin analysé : ${context.rootPath}`));
  children.push(new Paragraph({ text: `Date de l'analyse : ${new Date(now * 1000).toLocaleDateString('fr-FR')}` }));
  children.push(new Paragraph({ text: `Outil utilisé : Archifiltre v${version}`, spacing: { after: 120 } }));

  // 1. Objectifs
  children.push(H("1. Objectifs de l'audit", HeadingLevel.HEADING_1));
  [
    "Appréhender le contenu d'une arborescence",
    "Améliorer l'organisation : structure plus intuitive et plus pérenne",
    'Réduire la complexité (profondeur < 7 niveaux, chemins < 256 caractères)',
    'Prévenir les risques : versions multiples, fichiers obsolètes, éléments bloquants pour le versement en SAE',
    "Harmoniser les pratiques de nommage et d'organisation",
    'Réduire les espaces de stockage : gains financier, environnemental et de temps',
  ].forEach((t) => children.push(bullet(t)));

  // 2.1 Chiffres clés
  children.push(H('2. Analyse quantitative', HeadingLevel.HEADING_1));
  children.push(H("2.1 Chiffres clés de l'arborescence"));
  children.push(
    table(
      ['Métrique', 'Valeur'],
      [
        ["Taille de l'arborescence", humanSize(tot.total_size as number)],
        ['Nombre de dossiers', N(tot.dir_count as number)],
        ['Nombre de fichiers', N(tot.file_count as number)],
        ['Profondeur maximale', `${N(depth.max_depth as number)} niveaux`],
        ['Profondeur moyenne', `${Number(depth.avg_depth).toFixed(1)} niveaux`],
        [
          'Impact environnemental',
          `${co2Str(totalCO2)}  ≈  ${(totalCO2 / KM_FACTORS.voiture).toFixed(2)} km voiture · ${(totalCO2 / KM_FACTORS.train).toFixed(1)} km train · ${(totalCO2 / KM_FACTORS.avion).toFixed(2)} km avion`,
        ],
        ['Dates extrêmes', `${dateFr(tot.min_mtime as number)} → ${dateFr(tot.max_mtime as number)}`],
        ['Dossiers vides', N(emptyDirs)],
        ['Fichiers vides', N(tot.empty_files as number)],
        ['Nombre de formats identifiés', N(nFormats as number)],
        ['Chemin le plus long', `${N(tot.longest_path_len as number)} caractères`],
        [`Fichiers au chemin > ${RISK_PATH_THRESHOLD} caractères`, N(tot.paths_over_risk as number)],
      ],
      [3500, 6000]
    )
  );
  children.push(
    note(
      'CO₂ : 11,6 g CO₂e/Go/an (empreinte de stockage). Conversions en km indicatives (base ADEME), à ajuster par le service. Les formats sont déterminés par les extensions de fichiers.'
    )
  );
  children.push(
    note(
      `Note : les éléments dont le chemin dépasse ${RISK_PATH_THRESHOLD} caractères représentent un risque lors des copies ou migrations de serveurs.`
    )
  );

  // Formats
  children.push(H('Formats de fichiers'));
  children.push(
    table(
      ['Catégorie', 'Nombre de fichiers', 'Poids total'],
      categories.map((c) => [c.label, N(c.c), humanSize(c.sz)]),
      [4000, 3000, 2500]
    )
  );

  // Top oldest / largest
  children.push(H(`Top ${topN} des éléments les plus anciens`));
  children.push(
    table(
      ['Fichier', 'Date', 'Chemin', 'Poids'],
      oldest.map((f) => [basename(f.path as string), dateFr(f.mtime as number), f.path as string, humanSize(f.sz as number)]),
      [2600, 1400, 5000, 1200]
    )
  );
  children.push(note('Date de référence : dernière modification remontée par le système de fichiers.'));
  children.push(H(`Top ${topN} des éléments les plus volumineux`));
  children.push(
    table(
      ['Fichier', 'Date', 'Chemin', 'Poids'],
      largest.map((f) => [basename(f.path as string), dateFr(f.mtime as number), f.path as string, humanSize(f.sz as number)]),
      [2600, 1400, 5000, 1200]
    )
  );

  // Anomalies
  children.push(H('Autres anomalies potentielles'));
  children.push(runs(new TextRun({ text: `Dossiers surchargés (> ${OVERLOAD_THRESHOLD} éléments) : ${N(overloaded.length)}`, bold: true })));
  if (overloaded.length)
    children.push(
      table(['Dossier', "Nombre d'éléments"], overloaded.map((o) => [(o.parent as string) || '(racine)', N(o.c as number)]), [8000, 2000])
    );
  children.push(runs(new TextRun({ text: `Chemins trop longs (> ${LONG_PATH_THRESHOLD} caractères) : ${N(longPaths.length)}`, bold: true })));
  if (longPaths.length)
    children.push(
      table(
        ['Chemin', 'Nb caractères'],
        longPaths.map((p) => [p.path as string, { t: String(p.l), color: (p.l as number) > RISK_PATH_THRESHOLD ? 'C00000' : undefined }]),
        [8500, 1500]
      )
    );
  children.push(
    runs(
      new TextRun({ text: 'Fichiers anciens : ', bold: true }),
      new TextRun(`+ de 5 ans : ${N(old.o5 as number)}   ·   + de 10 ans : ${N(old.o10 as number)}   ·   + de 20 ans : ${N(old.o20 as number)}`)
    )
  );
  children.push(
    runs(
      new TextRun({ text: 'Nommage : ', bold: true }),
      new TextRun(`${N(special as number)} élément(s) contenant des caractères problématiques (< > : " | ? *)`)
    )
  );

  // 2.2 Redondances (fichiers uniquement en v1)
  children.push(H('2.2 Chiffres clés des redondances'));
  children.push(
    table(
      ['Métrique', 'Valeur'],
      [
        ['Doublons de fichiers (groupes)', N(dup.groups as number)],
        ['Fichiers redondants (copies en trop)', N(dup.redundant as number)],
        ['Volume récupérable si suppression des redondances', humanSize(dup.wasted as number)],
        ['CO₂ économisé', co2Str(savedCO2)],
      ],
      [5500, 4000]
    )
  );
  if (topDupCount.length) {
    children.push(H('Top des éléments les plus redondants', HeadingLevel.HEADING_3));
    children.push(
      table(
        ['Fichier', 'Nombre de copies', 'Poids unitaire'],
        topDupCount.map((d) => [d.name as string, N(d.c as number), humanSize(d.sz as number)]),
        [5000, 2500, 2000]
      )
    );
    children.push(H('Top des éléments redondants les plus volumineux', HeadingLevel.HEADING_3));
    children.push(
      table(
        ['Fichier', 'Copies', 'Poids unitaire', 'Volume gaspillé'],
        topDupVol.map((d) => [d.name as string, N(d.c as number), humanSize(d.sz as number), humanSize(d.wasted as number)]),
        [3800, 1500, 2200, 2500]
      )
    );
  }

  // 2.3 ROT
  children.push(H('2.3 Fichiers à éliminer (ROT — Redundant, Obsolete, Trivial)'));
  children.push(
    runs(
      new TextRun({ text: 'Éléments tagués « à éliminer » : ', bold: true }),
      new TextRun(deleteVol.n ? `${N(deleteVol.n)} élément(s), ${humanSize(deleteVol.v)}` : 'aucun élément tagué dans ce scan.')
    )
  );
  children.push(note("Le détail des éléments tagués peut être fourni via l'export Excel d'accompagnement."));

  // 3. Qualitative
  children.push(H('3. Analyse qualitative et archivistique', HeadingLevel.HEADING_1));
  children.push(note("À remplir par l'archiviste à partir de l'analyse du contenu et des échanges avec le service producteur."));

  // 4. Recommandations
  children.push(H('4. Recommandations / Préconisations', HeadingLevel.HEADING_1));
  children.push(runs(new TextRun({ text: 'Priorité n°1', bold: true })));
  ['Supprimer les doublons', 'Réorganiser les dossiers surchargés', 'Corriger les chemins trop longs'].forEach((t) => children.push(bullet(t)));
  children.push(runs(new TextRun({ text: 'Priorité n°2', bold: true })));
  [
    'Vérifier les fichiers volumineux à conserver',
    'Réaliser un tableau de gestion (durées de conservation, sorts finaux)',
    'Repérer les éléments dont la durée de conservation est atteinte (éliminer / verser en SAE)',
  ].forEach((t) => children.push(bullet(t)));
  children.push(runs(new TextRun({ text: 'Priorité n°3', bold: true })));
  [
    'Corriger les nommages problématiques',
    'Adopter et maintenir un glossaire des acronymes',
    'Programmer des audits réguliers',
    "Désigner un·e responsable de l'administration de l'arborescence",
  ].forEach((t) => children.push(bullet(t)));

  children.push(H('Vos ressources'));
  children.push(bullet('Lien vers les documents ressources'));
  children.push(bullet('Contact des archivistes référents'));

  const doc = new Document({
    creator: 'Archifiltre',
    title: `Rapport d'audit — ${treeName}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `Document généré par Archifiltre v${version} — `, size: 16, color: '888888' }),
                  new ExternalHyperlink({ link: 'https://www.archifiltre.org', children: [new TextRun({ text: 'archifiltre.org', size: 16, color: '2A6EBB' })] }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await Packer.toBuffer(doc));
  const fileCount = Number(tot.file_count);
  logger.info('Audit report export completed', { outputPath, files: fileCount });
  return fileCount;
}
