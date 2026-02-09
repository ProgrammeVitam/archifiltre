/**
 * Svelte stores for Archifiltre UI state management
 */

import { writable, derived } from 'svelte/store';

// ================================
// Types
// ================================

export type WorkflowStep = 'select' | 'scan' | 'checksum' | 'export' | 'complete';
export type OperationType = 'idle' | 'scanning' | 'checksum' | 'exporting';

export interface ScanOptions {
	path: string;
	includeHidden: boolean;
	batchSize: number;
	disableArchives: boolean;
}

export interface ChecksumOptions {
	algorithm: 'xxhash64' | 'md5' | 'sha256' | 'sha512';
	eachFile: boolean;
}

export interface ExportOptions {
	outputPath: string;
	fullPaths: boolean;
}

export interface ScanResult {
	filesDiscovered: number;
	duplicateGroups: number;
	folders: number;
	emptyFolders: number;
	hiddenFiles: number;
	totalSize: number;
}

export interface TerminalLine {
	id: number;
	text: string;
	stream: 'stdout' | 'stderr' | 'info' | 'success' | 'error';
	timestamp: Date;
}

// ================================
// Default Values
// ================================

const defaultScanOptions: ScanOptions = {
	path: '',
	includeHidden: false,
	batchSize: 1000,
	disableArchives: false
};

const defaultChecksumOptions: ChecksumOptions = {
	algorithm: 'xxhash64',
	eachFile: false
};

const defaultExportOptions: ExportOptions = {
	outputPath: '',
	fullPaths: false
};

const defaultScanResult: ScanResult = {
	filesDiscovered: 0,
	duplicateGroups: 0,
	folders: 0,
	emptyFolders: 0,
	hiddenFiles: 0,
	totalSize: 0
};

// ================================
// Stores
// ================================

export const currentStep = writable<WorkflowStep>('select');
export const completedSteps = writable<WorkflowStep[]>([]);
export const operationType = writable<OperationType>('idle');
export const isRunning = writable(false);
export const scanOptions = writable<ScanOptions>(defaultScanOptions);
export const scanResult = writable<ScanResult>(defaultScanResult);
export const checksumOptions = writable<ChecksumOptions>(defaultChecksumOptions);
export const exportOptions = writable<ExportOptions>(defaultExportOptions);
export const terminalOutput = writable<TerminalLine[]>([]);
export const cliVersion = writable<string | null>(null);
export const healthStatus = writable<'unknown' | 'healthy' | 'unhealthy'>('unknown');

// ================================
// Derived Stores
// ================================

export const canProceed = derived(
	[currentStep, isRunning, scanOptions, scanResult],
	([$step, $running, $scanOpts, $scanRes]) => {
		if ($running) return false;
		switch ($step) {
			case 'select':
				return $scanOpts.path.length > 0;
			case 'scan':
				return $scanRes.filesDiscovered > 0;
			case 'checksum':
				return true;
			case 'export':
				return true;
			default:
				return false;
		}
	}
);

// ================================
// Actions
// ================================

let terminalLineId = 0;

export function addTerminalLine(text: string, stream: TerminalLine['stream'] = 'stdout'): void {
	terminalOutput.update((lines) => [
		...lines,
		{ id: terminalLineId++, text, stream, timestamp: new Date() }
	]);
}

export function clearTerminal(): void {
	terminalOutput.set([]);
}

export function setStep(step: WorkflowStep): void {
	currentStep.set(step);
}

export function completeStep(step: WorkflowStep): void {
	completedSteps.update((steps) => (steps.includes(step) ? steps : [...steps, step]));
}

export function nextStep(): void {
	const steps: WorkflowStep[] = ['select', 'scan', 'checksum', 'export', 'complete'];
	currentStep.update((current) => {
		const idx = steps.indexOf(current);
		completeStep(current);
		return steps[Math.min(idx + 1, steps.length - 1)];
	});
}

export function previousStep(): void {
	const steps: WorkflowStep[] = ['select', 'scan', 'checksum', 'export', 'complete'];
	currentStep.update((current) => {
		const idx = steps.indexOf(current);
		return steps[Math.max(idx - 1, 0)];
	});
}

export function startOperation(type: OperationType): void {
	operationType.set(type);
	isRunning.set(true);
}

export function endOperation(): void {
	operationType.set('idle');
	isRunning.set(false);
}

export function resetAll(): void {
	currentStep.set('select');
	completedSteps.set([]);
	operationType.set('idle');
	isRunning.set(false);
	scanOptions.set(defaultScanOptions);
	scanResult.set(defaultScanResult);
	checksumOptions.set(defaultChecksumOptions);
	exportOptions.set(defaultExportOptions);
	terminalOutput.set([]);
}

export function parseScanOutput(line: string): void {
	const filesMatch = line.match(/Files discovered:\s*([\d,]+)/i);
	if (filesMatch) {
		scanResult.update((r) => ({ ...r, filesDiscovered: parseInt(filesMatch[1].replace(/,/g, ''), 10) }));
	}

	const dupMatch = line.match(/Potential duplicates:\s*([\d,]+)\s*files?\s*in\s*([\d,]+)\s*groups?/i);
	if (dupMatch) {
		scanResult.update((r) => ({ ...r, duplicateGroups: parseInt(dupMatch[2].replace(/,/g, ''), 10) }));
	}

	const foldersMatch = line.match(/Folders:\s*([\d,]+)/i);
	if (foldersMatch) {
		scanResult.update((r) => ({ ...r, folders: parseInt(foldersMatch[1].replace(/,/g, ''), 10) }));
	}

	const emptyMatch = line.match(/Empty folders:\s*([\d,]+)/i);
	if (emptyMatch) {
		scanResult.update((r) => ({ ...r, emptyFolders: parseInt(emptyMatch[1].replace(/,/g, ''), 10) }));
	}

	const hiddenMatch = line.match(/Hidden files:\s*([\d,]+)/i);
	if (hiddenMatch) {
		scanResult.update((r) => ({ ...r, hiddenFiles: parseInt(hiddenMatch[1].replace(/,/g, ''), 10) }));
	}
}
