/**
 * Archival exports — RESIP (SEDA) CSV and a two-sheet Excel workbook.
 *
 * Both walk the scan as a tree (parent-before-children) and join in the
 * user's enrichment (alias, comment, tags, delete marks). They share one
 * in-memory loader, `loadHierarchy`, then format:
 *
 *  - RESIP: a flat SEDA import CSV with ID / ParentID references, one row per
 *    surviving ArchiveUnit (Item for files, RecordGrp for folders). Elements
 *    marked "to delete" (and their subtrees, via the delete cascade) are excluded.
 *  - Excel: sheet "Données" (every element, all columns) + sheet "Visualisation"
 *    (the same tree with native Excel row outline-grouping so folders collapse).
 *
 * The scan is loaded whole rather than streamed: archival exports run on curated
 * trees and both formats need the full structure (date roll-ups, ID references,
 * outline nesting) at once.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { logger } from '@lib/logging.ts';
import type { DatabaseConnection } from '@lib/database.ts';
import type { PipelineContext } from '@lib/pipeline-context.ts';
import { escapeCsvValue, loadEnrichmentForExport } from '@extensions/csv-export.ts';

// === Shared hierarchy model ===

export interface HierarchyNode {
  /** Sequential archival ID (1 = the synthetic root record group). */
  id: number;
  /** ID of the parent node; '' for the root. */
  parentId: number | '';
  /** Path relative to the scan root ('' for the root itself). */
  path: string;
  /** Basename shown as the title when no alias is set. */
  name: string;
  isDirectory: boolean;
  /** Nesting level: root = 0, its direct children = 1, … */
  depth: number;
  /** Bytes: a file's own size, or a folder's total rolled up from descendants. */
  size: number;
  /** Descendant file count for folders; undefined for files. */
  fileCount?: number;
  contentSize: number | null;
  /** File modification time (epoch seconds); null for folders. */
  mtime: number | null;
  hash: string | null;
  alias: string | null;
  comment: string | null;
  /** Tag names assigned to this element, sorted. */
  tags: string[];
  /** True if this element (or an ancestor) is marked for deletion. */
  taggedForDeletion: boolean;
  /** Oldest / newest content date (epoch seconds): a file's mtime, or a folder's descendant range. */
  startDate: number | null;
  endDate: number | null;
}

interface RawRow {
  path: string;
  physical_size: number;
  content_size: number | null;
  mtime: number;
  is_directory: boolean;
  hash: string | null;
}

/** Nearest ancestor directory of a relative path ('' = the root). */
function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

/** True if this path, or any ancestor, is directly delete-marked (the delete cascade). */
function isUnderDeleteMark(p: string, deleteMarks: Set<string>): boolean {
  if (deleteMarks.has(p)) return true;
  let cur = p;
  let i: number;
  while ((i = cur.lastIndexOf('/')) >= 0) {
    cur = cur.slice(0, i);
    if (deleteMarks.has(cur)) return true;
  }
  return false;
}

export interface HierarchyLoadOptions {
  /** Drop elements marked for deletion and their subtrees (RESIP). */
  excludeDeleted: boolean;
}

/**
 * Load the whole scan as an ordered (pre-order) list of nodes with enrichment,
 * ID/ParentID references, and per-folder date ranges rolled up from descendants.
 */
export async function loadHierarchy(
  context: PipelineContext,
  options: HierarchyLoadOptions
): Promise<HierarchyNode[]> {
  const db: DatabaseConnection = context.database;
  const runId = context.runId;

  const [rowsRes, deleteRes, enrichment] = await Promise.all([
    db.pg.query<RawRow>(
      `SELECT path, physical_size, content_size, mtime, is_directory, hash
       FROM files WHERE run_id = $1 ORDER BY path`,
      [runId]
    ),
    db.pg.query<{ path: string }>(`SELECT path FROM delete_tags WHERE run_id = $1`, [runId]),
    loadEnrichmentForExport(db, runId),
  ]);

  const deleteMarks = new Set(deleteRes.rows.map((r) => r.path));

  // Real elements (the scan root itself is synthesised below), optionally minus deletions.
  const rows = rowsRes.rows.filter((r) => {
    if (r.path === '') return false;
    if (options.excludeDeleted && isUnderDeleteMark(r.path, deleteMarks)) return false;
    return true;
  });

  // Roll each file up into every ancestor folder (incl. the root '') so folders get a
  // total size, a descendant file count, and an oldest/newest content date range —
  // computed here rather than read from dir_stats, which a plain (non-owner) scan never
  // populates.
  const dirDates = new Map<string, { min: number; max: number }>();
  const dirSize = new Map<string, number>();
  const dirFiles = new Map<string, number>();
  const rollDate = (dir: string, t: number) => {
    const cur = dirDates.get(dir);
    if (!cur) dirDates.set(dir, { min: t, max: t });
    else {
      if (t < cur.min) cur.min = t;
      if (t > cur.max) cur.max = t;
    }
  };
  for (const r of rows) {
    if (r.is_directory) continue;
    let cur = r.path;
    const ancestors: string[] = [''];
    let i: number;
    while ((i = cur.lastIndexOf('/')) >= 0) {
      cur = cur.slice(0, i);
      ancestors.push(cur);
    }
    for (const dir of ancestors) {
      rollDate(dir, r.mtime);
      dirSize.set(dir, (dirSize.get(dir) ?? 0) + r.physical_size);
      dirFiles.set(dir, (dirFiles.get(dir) ?? 0) + 1);
    }
  }

  const rootRange = dirDates.get('');
  const rootName = context.rootPath ? path.basename(context.rootPath) : 'racine';

  // Synthetic root record group first, then every element in pre-order (path sort).
  const ordered: HierarchyNode[] = [
    {
      id: 1,
      parentId: '',
      path: '',
      name: enrichment.aliases.get('') ?? rootName,
      isDirectory: true,
      depth: 0,
      size: dirSize.get('') ?? 0,
      fileCount: dirFiles.get('') ?? 0,
      contentSize: null,
      mtime: null,
      hash: null,
      alias: enrichment.aliases.get('') ?? null,
      comment: enrichment.comments.get('') ?? null,
      tags: [...(enrichment.tagsByPath.get('') ?? [])].sort((a, b) => a.localeCompare(b)),
      taggedForDeletion: false,
      startDate: rootRange?.min ?? null,
      endDate: rootRange?.max ?? null,
    },
  ];

  const pathToId = new Map<string, number>([['', 1]]);
  let nextId = 2;
  for (const r of rows) {
    const range = r.is_directory ? dirDates.get(r.path) : null;
    const node: HierarchyNode = {
      id: nextId,
      parentId: 0, // filled in the second pass once every id is known
      path: r.path,
      name: r.path.split('/').pop() ?? r.path,
      isDirectory: r.is_directory,
      depth: r.path === '' ? 0 : r.path.split('/').length,
      size: r.is_directory ? (dirSize.get(r.path) ?? 0) : r.physical_size,
      fileCount: r.is_directory ? (dirFiles.get(r.path) ?? 0) : undefined,
      contentSize: r.content_size,
      mtime: r.is_directory ? null : r.mtime,
      hash: r.hash,
      alias: enrichment.aliases.get(r.path) ?? null,
      comment: enrichment.comments.get(r.path) ?? null,
      tags: [...(enrichment.tagsByPath.get(r.path) ?? [])].sort((a, b) => a.localeCompare(b)),
      taggedForDeletion: isUnderDeleteMark(r.path, deleteMarks),
      startDate: r.is_directory ? (range?.min ?? null) : r.mtime,
      endDate: r.is_directory ? (range?.max ?? null) : r.mtime,
    };
    ordered.push(node);
    pathToId.set(r.path, nextId);
    nextId++;
  }

  // Resolve ParentID now that every path has an id (missing parent → the root).
  for (const node of ordered) {
    if (node.id === 1) continue;
    const parent = parentPath(node.path);
    node.parentId = parent === '' ? 1 : (pathToId.get(parent) ?? 1);
  }

  logger.debug('Loaded hierarchy for archival export', {
    runId,
    nodes: ordered.length,
    excludeDeleted: options.excludeDeleted,
  });
  return ordered;
}

/**
 * Format an epoch-seconds date as yyyy-mm-dd in LOCAL time (matching what the user
 * sees for the file's date in the UI), or '' when absent. UTC would shift dates near
 * midnight back a day.
 */
function ymd(epochSeconds: number | null): string {
  if (epochSeconds == null) return '';
  return localYmd(new Date(epochSeconds * 1000));
}

function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// === RESIP (SEDA) CSV ===

const RESIP_FIXED_COLUMNS = [
  'ID',
  'ParentID',
  'File',
  'Content.DescriptionLevel',
  'Content.Title',
  'Content.ArchivalAgencyArchiveUnitIdentifier',
  'Content.StartDate',
  'Content.EndDate',
  'Content.TransactedDate',
  'Content.CustodialHistory.CustodialHistoryItem',
  'Content.Description',
] as const;

/**
 * Write the SEDA import CSV RESIP expects. Files become `Item` units carrying the
 * relative `File` path; folders become `RecordGrp` units with no binary. Repeated
 * tags spread across positional `Content.Tag.0…N` columns.
 */
export async function exportToResip(context: PipelineContext, outputPath: string): Promise<number> {
  const delimiter = ',';
  const nodes = await loadHierarchy(context, { excludeDeleted: true });

  const maxTags = nodes.reduce((m, n) => Math.max(m, n.tags.length), 0);
  const tagColumns = Array.from({ length: maxTags }, (_, i) => `Content.Tag.${i}`);
  const transactedDate = localYmd(new Date());

  const esc = (v: string | number) => escapeCsvValue(v, delimiter);
  const lines: string[] = [[...RESIP_FIXED_COLUMNS, ...tagColumns].join(delimiter)];

  for (const node of nodes) {
    const values: (string | number)[] = [
      node.id,
      node.parentId,
      node.isDirectory ? '' : node.path, // File: binary path for Items only
      node.isDirectory ? 'RecordGrp' : 'Item',
      node.alias ?? node.name, // Title: alias if set, else original name
      '', // ArchivalAgencyArchiveUnitIdentifier — no such field captured yet
      ymd(node.startDate),
      ymd(node.endDate),
      transactedDate,
      '', // CustodialHistory.CustodialHistoryItem — no such field captured yet
      node.comment ?? '',
    ];
    for (let i = 0; i < maxTags; i++) values.push(node.tags[i] ?? '');
    lines.push(values.map(esc).join(delimiter));

    if (context.onProgress && node.id % 2000 === 0) {
      context.onProgress('export', node.id, nodes.length);
    }
  }

  await fsp.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  logger.info('RESIP export completed', { outputPath, units: nodes.length });
  return nodes.length;
}

// === Excel workbook ===

/** Bytes → human-readable (Ko/Mo/Go), French-style. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/**
 * Write a two-sheet workbook: "Données" (every element, all columns incl.
 * enrichment) and "Visualisation" (the same tree, with native Excel row
 * outline-grouping so folders collapse/expand).
 */
export async function exportToXlsx(context: PipelineContext, outputPath: string): Promise<number> {
  const nodes = await loadHierarchy(context, { excludeDeleted: false });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Archifiltre';
  wb.created = new Date();

  // ── Sheet 1: Données ──────────────────────────────────────────────────────
  const data = wb.addWorksheet('Données', { views: [{ state: 'frozen', ySplit: 1 }] });
  data.columns = [
    { header: 'Chemin', key: 'chemin', width: 60 },
    { header: 'Nom', key: 'nom', width: 30 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Profondeur', key: 'profondeur', width: 11 },
    { header: 'Taille (octets)', key: 'taille', width: 14 },
    { header: 'Taille', key: 'tailleLisible', width: 12 },
    { header: 'Date début', key: 'debut', width: 12 },
    { header: 'Date fin', key: 'fin', width: 12 },
    { header: 'Empreinte', key: 'hash', width: 34 },
    { header: 'Alias', key: 'alias', width: 24 },
    { header: 'Commentaire', key: 'commentaire', width: 40 },
    { header: 'Étiquettes', key: 'tags', width: 26 },
    { header: 'À supprimer', key: 'supprimer', width: 12 },
  ];
  data.getRow(1).font = { bold: true };

  for (const node of nodes) {
    data.addRow({
      chemin: node.path || node.name,
      nom: node.name,
      type: node.isDirectory ? 'Dossier' : 'Fichier',
      profondeur: node.depth,
      taille: node.size,
      tailleLisible: humanSize(node.size),
      debut: ymd(node.startDate),
      fin: ymd(node.endDate),
      hash: node.hash ?? '',
      alias: node.alias ?? '',
      commentaire: node.comment ?? '',
      tags: node.tags.join(', '),
      supprimer: node.taggedForDeletion ? 'Oui' : '',
    });
  }

  // ── Sheet 2: Visualisation ────────────────────────────────────────────────
  const viz = wb.addWorksheet('Visualisation', { views: [{ state: 'frozen', ySplit: 1 }] });
  // Parent rows come BEFORE their children (pre-order), so the collapse summary
  // sits above each group.
  viz.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  viz.columns = [
    { header: 'Arborescence', key: 'arbre', width: 60 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Taille', key: 'taille', width: 14 },
    { header: 'Éléments', key: 'elements', width: 10 },
  ];
  viz.getRow(1).font = { bold: true };

  for (const node of nodes) {
    const row = viz.addRow({
      arbre: `${node.isDirectory ? '📁' : '📄'} ${node.alias ?? node.name}`,
      type: node.isDirectory ? 'Dossier' : 'Fichier',
      taille: humanSize(node.size),
      elements: node.isDirectory ? (node.fileCount ?? 0) : '',
    });
    // Native Excel grouping: outline level = depth (Excel caps at 7).
    row.outlineLevel = Math.min(node.depth, 7);
    // Indent the tree cell to mirror the outline level visually.
    row.getCell('arbre').alignment = { indent: Math.min(node.depth, 15) };
    if (node.taggedForDeletion) row.getCell('arbre').font = { strike: true, color: { argb: 'FF999999' } };
    if (context.onProgress && node.id % 2000 === 0) {
      context.onProgress('export', node.id, nodes.length);
    }
  }

  await wb.xlsx.writeFile(outputPath);
  logger.info('Excel export completed', { outputPath, rows: nodes.length });
  return nodes.length;
}
