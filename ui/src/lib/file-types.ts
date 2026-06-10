export type FileType =
	| 'folder'
	| 'document'
	| 'image'
	| 'video'
	| 'spreadsheet'
	| 'presentation'
	| 'publication'
	| 'email'
	| 'audio'
	| 'compressed'
	| 'other';

const EXTENSION_TO_TYPE: Record<string, FileType> = {
	// Documents
	doc: 'document', docx: 'document', dot: 'document', dotm: 'document',
	dotx: 'document', odt: 'document', ott: 'document', rtf: 'document', txt: 'document',
	// Spreadsheets
	csv: 'spreadsheet', ods: 'spreadsheet', ots: 'spreadsheet', xls: 'spreadsheet',
	xlsm: 'spreadsheet', xlsx: 'spreadsheet', xlt: 'spreadsheet', xltm: 'spreadsheet',
	xltx: 'spreadsheet', xlw: 'spreadsheet',
	// Presentations
	odp: 'presentation', otp: 'presentation', pot: 'presentation', pps: 'presentation',
	ppsx: 'presentation', ppt: 'presentation', pptm: 'presentation', pptx: 'presentation',
	// Publications
	epub: 'publication', mobi: 'publication', pdf: 'publication',
	// Emails
	eml: 'email', msg: 'email', pst: 'email',
	// Images
	bmp: 'image', gif: 'image', jp2: 'image', jpeg: 'image', jpg: 'image',
	png: 'image', psd: 'image', svg: 'image', tif: 'image', tiff: 'image',
	// Videos
	avi: 'video', mkv: 'video', mov: 'video', mp4: 'video', mpeg: 'video', wmv: 'video',
	// Audio
	flac: 'audio', mp3: 'audio', ogg: 'audio', rf64: 'audio', wav: 'audio', wma: 'audio',
	// Compressed
	zip: 'compressed', tar: 'compressed', tgz: 'compressed', gz: 'compressed',
	'7z': 'compressed', rar: 'compressed', warc: 'compressed', arc: 'compressed',
};

export function getFileType(filename: string): FileType {
	const ext = filename.includes('.') ? (filename.split('.').pop()?.toLowerCase() ?? '') : '';
	return EXTENSION_TO_TYPE[ext] ?? 'other';
}
