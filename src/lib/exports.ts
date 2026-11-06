import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { toPng } from 'html-to-image';

export type ExportRow = Record<string, string | number>;

export interface ReportData {
  title: string;
  period: string;
  summary: Record<string, string>;
  rows: ExportRow[];
}

function fileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim() || 'mis-finanzas';
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Keep the object URL alive long enough for the browser to start downloading.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function headersFor(rows: ExportRow[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

function safeSpreadsheetValue(value: string | number): string | number {
  if (typeof value === 'number') return value;
  // Prevent spreadsheet applications from interpreting user-entered labels as formulas.
  return /^[\s\u0000-\u001f]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value)
    ? `'${value}`
    : value;
}

export function exportTable(
  rows: ExportRow[],
  format: 'csv' | 'xlsx',
  filename: string,
): void {
  const headers = headersFor(rows);
  if (!headers.length) throw new Error('Agrega movimientos antes de exportar la tabla.');
  const matrix = [
    headers.map(safeSpreadsheetValue),
    ...rows.map((row) => headers.map((header) => safeSpreadsheetValue(row[header] ?? ''))),
  ];
  if (format === 'csv') {
    const csv = matrix
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    download(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }), `${fileName(filename)}.csv`);
    return;
  }
  const worksheet = XLSX.utils.aoa_to_sheet(matrix);
  worksheet['!cols'] = headers.map((header) => ({
    wch: Math.min(48, Math.max(16, header.length + 2, ...rows.map((row) => String(row[header] ?? '').length + 2))),
  }));
  worksheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Movimientos');
  XLSX.writeFile(workbook, `${fileName(filename)}.xlsx`, { compression: true });
}

function exportPdf(data: ReportData): void {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 18;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const width = pageWidth - margin * 2;
  let y = 24;
  const newPage = () => { pdf.addPage(); y = 22; };
  const ensureRoom = (height: number) => { if (y + height > pageHeight - 22) newPage(); };

  pdf.setFillColor(27, 62, 52);
  pdf.rect(0, 0, pageWidth, 5, 'F');
  pdf.setTextColor(27, 62, 52);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  const titleLines = pdf.splitTextToSize(data.title, width);
  pdf.text(titleLines, margin, y);
  y += titleLines.length * 9;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor(102, 113, 108);
  pdf.text(`Periodo: ${data.period}`, margin, y);
  y += 7;
  pdf.text(`Generado: ${new Date().toLocaleDateString('es-NI')}`, margin, y);
  y += 14;

  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(27, 62, 52);
  pdf.setFontSize(13);
  pdf.text('Resumen financiero', margin, y);
  y += 8;
  for (const [label, value] of Object.entries(data.summary)) {
    const labels = pdf.splitTextToSize(label, width * 0.58);
    const values = pdf.splitTextToSize(value, width * 0.36);
    const height = Math.max(labels.length, values.length) * 5 + 5;
    ensureRoom(height);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(95, 105, 100);
    pdf.text(labels, margin, y);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(27, 62, 52);
    pdf.text(values, margin + width, y, { align: 'right' });
    y += height;
  }
  y += 7;
  ensureRoom(25);
  pdf.setFontSize(13);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Detalle de movimientos', margin, y);
  y += 8;

  const headers = headersFor(data.rows);
  if (!headers.length) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.text('No hay movimientos en este periodo.', margin, y);
  } else {
    const columnWidth = width / headers.length;
    const headerLines = headers.map((header) => pdf.splitTextToSize(header, columnWidth - 4));
    const headerHeight = Math.max(...headerLines.map((lines: string[]) => lines.length)) * 4 + 6;
    const drawHeader = () => {
      pdf.setFillColor(235, 241, 237);
      pdf.rect(margin, y, width, headerHeight, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(27, 62, 52);
      headerLines.forEach((lines: string[], index: number) => pdf.text(lines, margin + index * columnWidth + 2, y + 5));
      y += headerHeight;
    };
    drawHeader();
    data.rows.forEach((row, rowIndex) => {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      const cells: string[][] = headers.map((header) => pdf.splitTextToSize(String(row[header] ?? ''), columnWidth - 4));
      let line = 0;
      const lines = Math.max(...cells.map((cell) => cell.length));
      // Split unusually tall rows across pages, keeping the table heading on each page.
      while (line < lines) {
        const maxLines = Math.floor((pageHeight - 23 - y - 5) / 4);
        if (maxLines < 1) { newPage(); drawHeader(); continue; }
        const chunkLines = Math.min(maxLines, lines - line);
        const rowHeight = chunkLines * 4 + 5;
        if (rowIndex % 2 === 0) {
          pdf.setFillColor(249, 250, 249);
          pdf.rect(margin, y, width, rowHeight, 'F');
        }
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        pdf.setTextColor(53, 64, 58);
        cells.forEach((cell, index) => {
          const chunk = cell.slice(line, line + chunkLines);
          if (chunk.length) pdf.text(chunk, margin + index * columnWidth + 2, y + 5);
        });
        y += rowHeight;
        line += chunkLines;
        if (line < lines) { newPage(); drawHeader(); }
      }
    });
  }
  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    pdf.setPage(page);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(125, 134, 129);
    pdf.text('Informe personal · Mis finanzas', margin, pageHeight - 11);
    pdf.text(`${page} / ${pageCount}`, pageWidth - margin, pageHeight - 11, { align: 'right' });
  }
  pdf.save(`${fileName(data.title)}.pdf`);
}

async function exportDocx(data: ReportData): Promise<void> {
  const headers = headersFor(data.rows);
  const cell = (text: string, header = false) => new TableCell({
    shading: header ? { fill: 'EBF1ED' } : undefined,
    margins: { top: 100, bottom: 100, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: header, size: 20, color: header ? '1B3E34' : '35403A' })] })],
  });
  const document = new Document({
    creator: 'Mis finanzas',
    title: data.title,
    description: `Informe financiero: ${data.period}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22, color: '35403A' } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } },
      children: [
        new Paragraph({ text: data.title, heading: HeadingLevel.TITLE, spacing: { after: 160 } }),
        new Paragraph({ text: `Periodo: ${data.period}`, spacing: { after: 80 } }),
        new Paragraph({ text: `Generado: ${new Date().toLocaleDateString('es-NI')}`, spacing: { after: 300 } }),
        new Paragraph({ text: 'Resumen financiero', heading: HeadingLevel.HEADING_1 }),
        ...Object.entries(data.summary).map(([label, value]) => new Paragraph({
          spacing: { after: 130 },
          children: [new TextRun({ text: `${label}: ` }), new TextRun({ text: value, bold: true })],
        })),
        new Paragraph({ text: 'Detalle de movimientos', heading: HeadingLevel.HEADING_1 }),
        ...(headers.length ? [new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: headers.map((header) => cell(header, true)) }),
            ...data.rows.map((row) => new TableRow({ children: headers.map((header) => cell(String(row[header] ?? ''))) })),
          ],
        })] : [new Paragraph('No hay movimientos en este periodo.')]),
        new Paragraph({ text: 'Informe personal · Mis finanzas', alignment: AlignmentType.RIGHT, spacing: { before: 400 } }),
      ],
    }],
  });
  download(await Packer.toBlob(document), `${fileName(data.title)}.docx`);
}

export async function exportReport(data: ReportData, format: 'pdf' | 'docx'): Promise<void> {
  if (format === 'pdf') exportPdf(data);
  else await exportDocx(data);
}

export async function exportDashboard(element: HTMLElement): Promise<void> {
  await document.fonts.ready;
  const dataUrl = await toPng(element, {
    pixelRatio: 2,
    backgroundColor: '#f7f9f6',
    filter: (node) => !(node instanceof HTMLElement && node.dataset.exportIgnore === 'true'),
  });
  const response = await fetch(dataUrl);
  download(await response.blob(), `dashboard-${new Date().toISOString().slice(0, 10)}.png`);
}
