import {amountWords} from './amount-words';
import {Bill,State,totals,lineTotal,paid,balance,roundedTotal} from './domain';
import type {InvoiceTemplate} from './extensions';
export const safeFilename=(name:string)=>name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100)||'document';
const text=(value:unknown)=>String(value??'').replace(/₹/g,'INR ').replace(/[–—]/g,'-').replace(/→/g,'to').replace(/·/g,' / ');
const cash=(n:number)=>'INR '+n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
export function downloadBytes(name:string,bytes:Uint8Array,mime:string){const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:mime}));const link=document.createElement('a');link.href=url;link.download=safeFilename(name);link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
const excelSanitize = (v: string | number) => typeof v === 'number' ? v : (/^-?\d+(\.\d+)?$/.test(String(v ?? '').trim()) ? v : (/^[=+@-]/.test(String(v ?? '')) ? "'" + String(v) : v));
export async function workbookBytes(title:string,headers:string[],rows:(string|number)[][],description=''){
 const {default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook();workbook.creator='Billing Software';const sheet=workbook.addWorksheet('Report');
 sheet.addRow([title]);sheet.addRow([description]);sheet.addRow(headers);rows.forEach(r=>sheet.addRow(r.map(excelSanitize)));sheet.views=[{state:'frozen',ySplit:3}];sheet.autoFilter={from:{row:3,column:1},to:{row:3,column:headers.length}};
 sheet.getRow(1).font={bold:true,size:18,color:{argb:'FF5035BE'}};sheet.getRow(3).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(3).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF6246E5'}};
 headers.forEach((h,i)=>{const col=sheet.getColumn(i+1);col.width=Math.min(48,Math.max(15,h.length+3,...rows.slice(0,100).map(r=>String(r[i]??'').length+2)));col.alignment={vertical:'top',wrapText:true};if(/amount|total|value|due|paid|profit|tax|gst|expense|receipt|price|balance/i.test(h))col.numFmt='#,##0.00';});
 sheet.pageSetup={paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};return new Uint8Array(await workbook.xlsx.writeBuffer());
}
export async function reportPdfBytes(title:string,headers:string[],rows:(string|number)[][],description=''){
 const {jsPDF}=await import('jspdf');const {autoTable}=await import('jspdf-autotable');const doc=new jsPDF({orientation:headers.length>6?'landscape':'portrait'});const width=doc.internal.pageSize.getWidth();
 doc.setFontSize(18);doc.text(text(title),14,19);doc.setFontSize(9);doc.text(doc.splitTextToSize(text(description),width-28),14,27);
 autoTable(doc,{startY:38,head:[headers.map(text)],body:rows.map(r=>r.map(v=>typeof v==='number'?v.toLocaleString('en-IN',{maximumFractionDigits:2}):text(v))),styles:{fontSize:8,cellPadding:3,overflow:'linebreak'},headStyles:{fillColor:[98,70,229]},margin:{top:16,bottom:19}});
 for(let i=1;i<=doc.getNumberOfPages();i++){doc.setPage(i);doc.setFontSize(8);doc.text(`Billing Software / Page ${i} of ${doc.getNumberOfPages()}`,14,doc.internal.pageSize.getHeight()-9);}return new Uint8Array(doc.output('arraybuffer'));
}
export async function invoicePdfBytes(s:State,b:Bill,templateId?:string){
 const t=((!templateId && (b as any).templateSnapshot) ? (b as any).templateSnapshot : (s.templates.find(t=>t.id===(templateId||b.templateId||s.defaultTemplateId))||s.templates[0])) as InvoiceTemplate;const f=t.fields;const company=b.shopSnapshot||s.settings,customer=b.customerSnapshot||s.customers.find(c=>c.id===b.customerId);const total=totals(b),inter=b.taxMode==='Inter-state';const {jsPDF}=await import('jspdf');const {autoTable}=await import('jspdf-autotable');const doc=new jsPDF({orientation:t.orientation,format:t.paper.toLowerCase() as 'a4'|'letter'});const width=doc.internal.pageSize.getWidth();let y=14;
 const colour:[number,number,number]=[1,3,5].map(i=>parseInt(t.accent.slice(i,i+2),16)||0) as [number,number,number];
 const table=(head:string[]|null,body:(string|number)[][],options:Record<string,unknown>={})=>{autoTable(doc,{startY:y,...(head?{head:[head.map(text)]}:{}),body:body.map(r=>r.map(text)),rowPageBreak:'avoid',theme:t.borders?'grid':t.striped?'striped':'plain',styles:{fontSize:t.fontSize*0.75,cellPadding:1.5,overflow:'linebreak'},headStyles:{fillColor:colour,textColor:255},margin:{left:12,right:12,top:14,bottom:20},...options});y=(doc as typeof doc&{lastAutoTable:{finalY:number}}).lastAutoTable.finalY+2;};
 doc.setFontSize(16);doc.setTextColor(...colour);doc.text(text(t.title||(b.kind==='Quotation'?'Quotation':b.kind==='Service'?'Service Invoice':total.tax?'Tax Invoice':'Sales Invoice')),width/2,y,{align:'center'});y+=8;doc.setTextColor(20);
 if(f.logo&&company.logo){try{const response=await fetch(company.logo);if(!response.ok)throw new Error('Logo unavailable');const bytes=new Uint8Array(await response.arrayBuffer());const x=t.logoPosition==='right'?width-37:t.logoPosition==='center'?width/2-12:12;doc.addImage(bytes,'PNG',x,y,24,16,undefined,'FAST');y+=20;}catch{/* Unavailable session logos must not prevent invoice download. */}}
 const companyText=[f.shopName&&company.name,f.shopAddress&&company.address,f.shopGst&&'GSTIN: '+company.gst,f.shopPhone&&company.phone,f.shopEmail&&company.email].filter(Boolean).join('\n');
 const meta=[f.number&&'Document: '+b.id,f.date&&'Date: '+b.date,f.due&&'Due / valid until: '+b.due,f.reference&&'Reference: '+(b.jobId||b.sourceId||''),f.order&&'Buyer order: '+(b.orderRef||''),f.delivery&&'Delivery note: '+(b.deliveryNote||''),f.dispatch&&'Dispatch: '+(b.dispatch||''),f.destination&&'Place of supply: '+(b.placeOfSupply||'Tamil Nadu')].filter(Boolean).join('\n');table(null,[[companyText,meta]],{columnStyles:{0:{cellWidth:(width-24)/2},1:{cellWidth:(width-24)/2}}});
 const buyer=['Buyer (Bill to)',f.customerName&&customer?.name,f.customerAddress&&customer?.address,f.customerPhone&&customer?.phone,f.customerGst&&'GSTIN: '+(customer?.gst||'Not provided')].filter(Boolean).join('\n');const ship=b.shipTo;table(null,[[buyer,...(f.shipping?[['Ship to (Deliver to)',ship?.name||customer?.name,ship?.address||customer?.address,ship?.phone||customer?.phone,ship?.state,ship?.postalCode].filter(Boolean).join('\n')]:[])]]);
 const columns=t.columns.filter(c=>c.show);const itemRows=b.lines.map((l,i)=>{const tax=lineTotal(l,b.inclusive,b.taxMode);const specsText=l.printSpecifications&&typeof l.printSpecifications==='object'?Object.entries(l.printSpecifications).filter(([,v])=>v).map(([k,v])=>`${k.charAt(0).toUpperCase()+k.slice(1).replace(/([A-Z])/g,' $1')}: ${v}`).join(' · '):'';const descParts=[l.name,l.details,specsText,f.serials&&l.serials.join(', '),f.model&&s.products.find(p=>p.id===l.productId)?.model,f.warranty&&l.warranty>0&&'Warranty: '+l.warranty+' months'].filter(Boolean).join('\n');const cells:Record<string,string|number>={index:i+1,description:descParts,hsn:l.hsn||l.sac||'',tax:l.taxTreatment==='Exempt'?'Exempt':l.taxTreatment==='NonGST'?'Non-GST':l.tax+'%',qty:l.qty+(l.unit?' '+l.unit:''),rateIncl:cash(b.inclusive?l.rate:l.rate*(1+l.tax/100)),rateExcl:cash(b.inclusive?l.rate/(1+l.tax/100):l.rate),discount:l.discountType==='Amount'?cash(l.discount):l.discount+'%',warranty:l.warranty+' months',amount:cash(tax.base)};return columns.map(c=>cells[c.id]??'');});table(columns.map(c=>c.label),itemRows,{styles:{fontSize:Math.min(t.fontSize*0.75,9),cellPadding:1.5,overflow:'linebreak'},columnStyles:Object.fromEntries(columns.map((c,i)=>[i,{halign:c.align}]))});
 const summary:(string|number)[][]=[];if(f.subtotal)summary.push(['Taxable value',cash(total.base)]);if(f.taxes)summary.push(...(inter?[['IGST',cash(total.igst)]]:[['CGST',cash(total.cgst)],['SGST',cash(total.sgst)]]));if(f.grandTotal)summary.push(['Total',cash(roundedTotal(b))]);if(f.payments&&b.kind!=='Quotation')summary.push(['Received',cash(b.previewPaid??paid(s,b.id))],['Balance due',cash(b.previewPaid!==undefined?Math.max(0,roundedTotal(b)-b.previewPaid):balance(s,b))]);if(summary.length)table(null,summary,{columnStyles:{0:{fontStyle:'bold'},1:{halign:'right'}}});
 if(f.amountWords)table(null,[['Amount in words',amountWords(roundedTotal(b))]]);
 if(f.taxSummary){const groups=new Map<string,{hsn:string;rate:number;base:number;cgst:number;sgst:number;igst:number;treatment?:string}>();b.lines.forEach(l=>{const treatment=l.taxTreatment||'Taxable';const key=treatment+'-'+l.hsn+'-'+l.tax;const v=lineTotal(l,b.inclusive,b.taxMode);const row=groups.get(key)||{hsn:l.hsn,rate:(treatment==='Exempt'||treatment==='NonGST')?0:l.tax,base:0,cgst:0,sgst:0,igst:0,treatment};row.base+=v.base;row.cgst+=v.cgst;row.sgst+=v.sgst;row.igst+=v.igst;groups.set(key,row);});table(inter?['HSN / SAC','Rate','Taxable','IGST']:['HSN / SAC','GST rate','Taxable','CGST','SGST'],[...groups.values()].map(x=>[x.hsn,x.treatment==='Exempt'?'Exempt':x.treatment==='NonGST'?'Non-GST':x.rate+'%',cash(x.base),...(inter?[cash(x.igst)]:[cash(x.cgst),cash(x.sgst)])]));}
 if(f.notes&&b.notes)table(null,[['Notes',b.notes]]);if(f.declaration)table(null,[['Declaration',company.declaration]]);if(f.bank)table(null,[['Bank details',[company.name,company.bank,company.account,company.ifsc].join('\n')]]);if(f.signatures)table(null,[['Customer seal and signature','For '+company.name+'\n\nAuthorised signatory']]);
 for(let i=1;i<=doc.getNumberOfPages();i++){doc.setPage(i);doc.setFontSize(8);doc.setTextColor(70);if(f.footer&&t.footer)doc.text(text(t.footer),12,doc.internal.pageSize.getHeight()-12,{maxWidth:width-24});doc.text(`${b.id} / ${i} of ${doc.getNumberOfPages()}`,12,doc.internal.pageSize.getHeight()-7);}return new Uint8Array(doc.output('arraybuffer'));
}
export async function invoiceZipBytes(s:State,bills:Bill[],templateId?:string){if(!bills.length)throw new Error('Select at least one invoice.');if(bills.length>100)throw new Error('Export up to 100 invoices at a time.');const {default:JSZip}=await import('jszip');const zip=new JSZip();for(const b of bills){zip.file(safeFilename(b.id)+'.pdf',await invoicePdfBytes(s,b,templateId));}zip.file('invoice-index.xlsx',await workbookBytes('Invoice archive',['Invoice','Date','Customer','Total','Paid','Due'],bills.map(b=>[b.id,b.date,s.customers.find(c=>c.id===b.customerId)?.name||'',roundedTotal(b),paid(s,b.id),balance(s,b)]),'Selected invoice records'));return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});}

async function waitForPreviewAssets(element: HTMLElement) {
 const images=Array.from(element.querySelectorAll('img'));
 await Promise.all(images.map(image=>image.complete?Promise.resolve():new Promise<void>(resolve=>{image.addEventListener('load',()=>resolve(),{once:true});image.addEventListener('error',()=>resolve(),{once:true});})));
 if(document.fonts?.ready)await document.fonts.ready;
}

/** Render the exact browser invoice preview rather than rebuilding a second PDF layout. */
export async function invoicePreviewPdfBytes(element:HTMLElement,template:InvoiceTemplate){
 await waitForPreviewAssets(element);
 const [{jsPDF},html2canvasModule]=await Promise.all([import('jspdf'),import('html2canvas')]);const html2canvas=html2canvasModule.default as unknown as (element:HTMLElement,options?:Record<string,unknown>)=>Promise<HTMLCanvasElement>;
 const doc=new jsPDF({orientation:template.orientation,format:template.paper.toLowerCase() as 'a4'|'letter',unit:'pt'});
 const sourceWidth=Math.max(1,element.scrollWidth);
 // A bounded high-resolution raster preserves the exact approved browser layout
 // without jsPDF's HTML reflow, which can enlarge an A4 preview across many pages.
 const captureScale=Math.min(3,Math.max(2,2400/sourceWidth));
 const canvas=await html2canvas(element,{
  scale:captureScale,useCORS:true,allowTaint:false,backgroundColor:'#ffffff',logging:false,
  width:sourceWidth,height:Math.max(1,element.scrollHeight),windowWidth:sourceWidth,
  scrollX:0,scrollY:-window.scrollY,
 });
 const pageWidth=doc.internal.pageSize.getWidth();
 const pageHeight=doc.internal.pageSize.getHeight();
 const margin=12;
 const availableWidth=pageWidth-margin*2;
 const availableHeight=pageHeight-margin*2;
 const ratio=Math.min(availableWidth/canvas.width,availableHeight/canvas.height);
 const renderWidth=canvas.width*ratio;
 const renderHeight=canvas.height*ratio;
 doc.addImage(canvas.toDataURL('image/png'),'PNG',(pageWidth-renderWidth)/2,margin,renderWidth,renderHeight,undefined,'FAST');
 return new Uint8Array(doc.output('arraybuffer'));
}

export async function invoicePreviewZipBytes(entries:Array<{name:string;element:HTMLElement;template:InvoiceTemplate}>){
 if(!entries.length)throw new Error('Select at least one document.');
 if(entries.length>100)throw new Error('Export up to 100 documents at a time.');
 const {default:JSZip}=await import('jszip');const zip=new JSZip();
 for(const entry of entries)zip.file(safeFilename(entry.name)+'.pdf',await invoicePreviewPdfBytes(entry.element,entry.template));
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

export async function receiptPdfBytes(settings: any, receipt: any, invoice?: any, customer?: any) {
  const {jsPDF} = await import('jspdf');
  const {autoTable} = await import('jspdf-autotable');
  const doc = new jsPDF({orientation: 'portrait', format: 'a4'});
  const width = doc.internal.pageSize.getWidth();
  let y = 14;

  const table = (head: string[] | null, body: (string | number)[][], options: Record<string, unknown> = {}) => {
    autoTable(doc, {
      startY: y,
      ...(head ? {head: [head.map(text)]} : {}),
      body: body.map(r => r.map(text)),
      theme: 'grid',
      styles: {fontSize: 8.5, cellPadding: 2, overflow: 'linebreak'},
      headStyles: {fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold'},
      margin: {left: 14, right: 14},
      ...options,
    });
    y = (doc as any).lastAutoTable.finalY + 4;
  };

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('PAYMENT RECEIPT', width / 2, y, {align: 'center'});
  y += 7;

  const snap = receipt.receiptSnapshot;
  const seller = snap?.seller || settings;
  const cust = snap?.customer || customer || receipt.customerSnapshot;

  const logoSrc = settings?.logo || (seller?.logoFileId ? `/api/files/${seller.logoFileId}` : null);
  if (logoSrc) {
    try {
      const response = await fetch(logoSrc);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        doc.addImage(bytes, 'PNG', 14, y, 24, 16, undefined, 'FAST');
        y += 18;
      }
    } catch {}
  }

  const companyInfo = [
    seller?.name || settings?.name || 'Billing Software',
    seller?.address || settings?.address,
    (seller?.gst || settings?.gst) && ('GSTIN: ' + (seller?.gst || settings?.gst)),
    (seller?.phone || settings?.phone) && ('Phone: ' + (seller?.phone || settings?.phone)),
    (seller?.email || settings?.email) && ('Email: ' + (seller?.email || settings?.email)),
  ].filter(Boolean).join('\n');

  const receiptNo = snap?.receiptNumber || receipt.receiptNumber || receipt.id || receipt._id || 'RCP';
  const receiptDate = snap?.receiptDate || receipt.date || (receipt.createdAt ? String(receipt.createdAt).slice(0, 10) : '');
  const method = snap?.payment?.method || receipt.components?.[0]?.method || receipt.method || 'Cash';
  const ref = snap?.payment?.reference || receipt.components?.[0]?.reference || receipt.reference || 'N/A';

  const metaInfo = [
    'Receipt No: ' + receiptNo,
    'Receipt Date: ' + receiptDate,
    'Payment Method: ' + method,
    'Reference / UTR: ' + ref,
  ].join('\n');

  table(null, [[companyInfo, metaInfo]], {
    columnStyles: {0: {cellWidth: (width - 28) * 0.6}, 1: {cellWidth: (width - 28) * 0.4}},
  });

  const custName = cust?.name || 'Customer';
  const custPhone = cust?.phone || '-';
  const custAddress = cust?.address || '-';
  const custGst = cust?.gst || 'Unregistered';

  const receivedFromText = [
    'Received with thanks from: ' + custName,
    'Phone: ' + custPhone + '  |  GSTIN: ' + custGst,
    'Address: ' + custAddress,
  ].join('\n');

  table(null, [[receivedFromText]]);

  // Safe paise arithmetic — NEVER read invoice.due as a monetary amount
  const alloc = receipt.allocations?.[0];
  const amountPaidPaise = snap?.amountAppliedPaise
    ?? (alloc?.amountPaise || receipt.totalAmountPaise || receipt.amountPaise || (receipt.components?.[0]?.amountPaise || 0));
  const amountPaid = amountPaidPaise / 100;

  const invNumber = snap?.invoiceNumber
    || invoice?.invoiceNumber
    || invoice?.id
    || alloc?.targetId
    || receipt.invoiceId
    || 'Invoice';

  const invTotalPaise = snap?.invoiceTotalPaise
    ?? (invoice?.grandTotalPaise ?? (typeof invoice?.total === 'number' ? Math.round(invoice.total * 100) : amountPaidPaise));
  const invTotal = invTotalPaise / 100;

  const dueBeforePaise = snap?.dueBeforePaise
    ?? (typeof invoice?.duePaise === 'number' ? invoice.duePaise + amountPaidPaise : invTotalPaise);
  const dueBefore = dueBeforePaise / 100;

  const dueAfterPaise = snap?.dueAfterPaise
    ?? Math.max(0, dueBeforePaise - amountPaidPaise);
  const dueAfter = dueAfterPaise / 100;

  const custOutstandingPaise = snap?.customerOutstandingAfterPaise
    ?? (typeof customer?.balancePaise === 'number' ? customer.balancePaise : (typeof customer?.balance === 'number' ? Math.round(customer.balance * 100) : dueAfterPaise));
  const custOutstanding = custOutstandingPaise / 100;

  table(
    ['S.No', 'Settled Invoice #', 'Invoice Total', 'Due Before Receipt', 'Amount Paid Now', 'Remaining Due on Invoice'],
    [[
      '1',
      invNumber,
      cash(invTotal),
      cash(dueBefore),
      cash(amountPaid),
      cash(dueAfter),
    ]],
    {
      columnStyles: {
        0: {cellWidth: 12, halign: 'center'},
        1: {cellWidth: 38},
        2: {cellWidth: 32, halign: 'right'},
        3: {cellWidth: 32, halign: 'right'},
        4: {cellWidth: 32, halign: 'right', fontStyle: 'bold'},
        5: {cellWidth: 36, halign: 'right', fontStyle: 'bold'},
      },
    }
  );

  const words = amountWords(amountPaid);
  const summaryBox: (string | number)[][] = [
    ['Total Amount Received', cash(amountPaid)],
    ['Amount in Words', words],
    ['Remaining Due on this Invoice', cash(dueAfter)],
    ['Total Customer Outstanding Balance', cash(custOutstanding)],
  ];
  if (receipt.notes) {
    summaryBox.push(['Notes / Remarks', receipt.notes]);
  }
  table(null, summaryBox, {
    columnStyles: {0: {fontStyle: 'bold', cellWidth: 65}, 1: {fontStyle: 'normal'}},
  });

  y = Math.max(y + 8, doc.internal.pageSize.getHeight() - 38);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text('This is a computer-generated receipt.', 14, y);
  doc.setFont('helvetica', 'bold');
  doc.text('For ' + (seller?.name || settings?.name || 'Company'), width - 14, y - 6, {align: 'right'});
  doc.setFont('helvetica', 'normal');
  doc.text('Authorised Signatory', width - 14, y, {align: 'right'});

  return new Uint8Array(doc.output('arraybuffer'));
}

export async function paymentVoucherPdfBytes(settings: any, voucher: any) {
  const {jsPDF} = await import('jspdf');
  const {autoTable} = await import('jspdf-autotable');
  const doc = new jsPDF({orientation: 'portrait', format: 'a4'});
  const width = doc.internal.pageSize.getWidth();
  let y = 14;

  const table = (head: string[] | null, body: (string | number)[][], options: Record<string, unknown> = {}) => {
    autoTable(doc, {
      startY: y,
      ...(head ? {head: [head.map(text)]} : {}),
      body: body.map(r => r.map(text)),
      theme: 'grid',
      styles: {fontSize: 8.5, cellPadding: 2.2, overflow: 'linebreak'},
      headStyles: {fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold'},
      margin: {left: 14, right: 14},
      ...options,
    });
    y = (doc as any).lastAutoTable.finalY + 4;
  };

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('PAYMENT VOUCHER', width / 2, y, {align: 'center'});
  y += 7;

  if (settings?.logo) {
    try {
      const response = await fetch(settings.logo);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        doc.addImage(bytes, 'PNG', 14, y, 24, 16, undefined, 'FAST');
        y += 18;
      }
    } catch {}
  }

  const companyInfo = [
    settings?.name || 'Billing Software',
    settings?.address,
    settings?.gst && ('GSTIN: ' + settings.gst),
    settings?.phone && ('Phone: ' + settings.phone),
    settings?.email && ('Email: ' + settings.email),
  ].filter(Boolean).join('\n');

  const voucherNo = voucher.voucherNumber || voucher.id || voucher._id || 'PV';
  const voucherDate = voucher.date || (voucher.createdAt ? String(voucher.createdAt).slice(0, 10) : '');
  const amount = (voucher.amountPaise || 0) / 100;

  const metaInfo = [
    'Voucher No: ' + voucherNo,
    'Date: ' + voucherDate,
    'Payment Method: ' + (voucher.method || 'Cash'),
    'Payment Method: ' + (voucher.method || 'BankTransfer'),
    'Reference / UTR: ' + (voucher.reference || 'N/A'),
  ].join('\n');

  table(null, [[companyInfo, metaInfo]], {
    columnStyles: {0: {cellWidth: (width - 28) * 0.6}, 1: {cellWidth: (width - 28) * 0.4}},
  });

  table(null, [['Paid To: ' + (voucher.payeeName || 'Payee')]], {
    styles: {fontStyle: 'bold', fontSize: 10},
  });

  table(
    ['S.No', 'Purpose / Particulars', 'Account', 'Method', 'Amount (INR)'],
    [[
      '1',
      voucher.purpose || 'Payment',
      voucher.method || 'Cash',
      voucher.method || 'BankTransfer',
      cash(amount),
    ]],
    {
      columnStyles: {
        0: {cellWidth: 16, halign: 'center'},
        1: {cellWidth: 80},
        2: {cellWidth: 25},
        3: {cellWidth: 30},
        4: {halign: 'right', fontStyle: 'bold'},
      },
    }
  );

  const words = amountWords(amount);
  const summaryBox: (string | number)[][] = [
    ['Amount in Words', words],
  ];
  if (voucher.notes) {
    summaryBox.push(['Notes / Remarks', voucher.notes]);
  }
  table(null, summaryBox, {
    columnStyles: {0: {fontStyle: 'bold', cellWidth: 40}, 1: {fontStyle: 'normal'}},
  });

  y = Math.max(y + 16, doc.internal.pageSize.getHeight() - 40);
  table(null, [[
    '\n\n___________________________\nReceiver\'s Signature',
    'For ' + (settings?.name || 'Company') + '\n\n___________________________\nAuthorised Signatory',
  ]], {
    theme: 'plain',
    columnStyles: {
      0: {cellWidth: (width - 28) / 2, halign: 'left'},
      1: {cellWidth: (width - 28) / 2, halign: 'right'},
    },
  });

  return new Uint8Array(doc.output('arraybuffer'));
}

export async function deliveryChallanPdfBytes(settings: any, docData: any, customer?: any) {
  const {jsPDF} = await import('jspdf');
  const {autoTable} = await import('jspdf-autotable');
  const doc = new jsPDF({orientation: 'portrait', format: 'a4'});
  const width = doc.internal.pageSize.getWidth();
  let y = 14;

  const table = (head: string[] | null, body: (string | number)[][], options: Record<string, unknown> = {}) => {
    autoTable(doc, {
      startY: y,
      ...(head ? {head: [head.map(text)]} : {}),
      body: body.map(r => r.map(text)),
      theme: 'grid',
      styles: {fontSize: 8.5, cellPadding: 2, overflow: 'linebreak'},
      headStyles: {fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold'},
      margin: {left: 14, right: 14},
      ...options,
    });
    y = (doc as any).lastAutoTable.finalY + 4;
  };

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('DELIVERY CHALLAN', width / 2, y, {align: 'center'});
  y += 5;
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('(Non-Financial Document / Delivery Copy)', width / 2, y, {align: 'center'});
  doc.setTextColor(0);
  y += 6;

  if (settings?.logo) {
    try {
      const response = await fetch(settings.logo);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        doc.addImage(bytes, 'PNG', 14, y, 24, 16, undefined, 'FAST');
        y += 18;
      }
    } catch {}
  }

  const companyInfo = [
    settings?.name || 'Billing Software',
    settings?.address,
    settings?.gst && ('GSTIN: ' + settings.gst),
    settings?.phone && ('Phone: ' + settings.phone),
    settings?.email && ('Email: ' + settings.email),
  ].filter(Boolean).join('\n');

  const docId = docData.invoiceNumber || docData.jobNumber || docData.id || 'DOC';
  const challanNo = 'DC-' + docId;
  const challanDate = docData.invoiceDate || docData.date || (docData.createdAt ? String(docData.createdAt).slice(0, 10) : '');

  const metaInfo = [
    'Challan No: ' + challanNo,
    'Date: ' + challanDate,
    'Ref Document: ' + docId,
    (docData.orderRef || docData.orderReference) ? 'Buyer Order: ' + (docData.orderRef || docData.orderReference) : '',
    docData.deliveryNote ? 'Delivery Note: ' + docData.deliveryNote : '',
    (docData.dispatch || docData.dispatchThrough) ? 'Dispatch Through: ' + (docData.dispatch || docData.dispatchThrough) : '',
  ].filter(Boolean).join('\n');

  table(null, [[companyInfo, metaInfo]], {
    columnStyles: {0: {cellWidth: (width - 28) * 0.6}, 1: {cellWidth: (width - 28) * 0.4}},
  });

  const custName = customer?.name || docData.customerSnapshot?.name || docData.customerName || 'Customer';
  const custPhone = customer?.phone || docData.customerSnapshot?.phone || docData.customerPhone || '';
  const custAddress = customer?.address || docData.customerSnapshot?.address || '';
  const shipTo = docData.shipTo;

  const billToText = [
    'Bill To:',
    custName,
    custPhone && ('Phone: ' + custPhone),
    custAddress,
  ].filter(Boolean).join('\n');

  const shipToText = [
    'Ship To (Delivery Address):',
    shipTo?.name || custName,
    shipTo?.phone || custPhone,
    shipTo?.address || custAddress,
    shipTo?.state || '',
  ].filter(Boolean).join('\n');

  table(null, [[billToText, shipToText]], {
    columnStyles: {0: {cellWidth: (width - 28) / 2}, 1: {cellWidth: (width - 28) / 2}},
  });

  const lines = docData.lines || (docData.items ? docData.items : []);
  const rows = lines.map((l: any, i: number) => {
    const specs = l.printSpecifications && typeof l.printSpecifications === 'object'
      ? Object.entries(l.printSpecifications)
          .filter(([, v]) => v)
          .map(([k, v]) => k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1') + ': ' + v)
          .join(' · ')
      : '';
    const desc = [l.name, l.details, specs].filter(Boolean).join('\n');
    const qty = (l.qty ?? l.quantity ?? 1) + ' ' + (l.unit || 'Piece');
    return [String(i + 1), desc, qty];
  });

  table(
    ['S.No', 'Item / Service Description & Printing Specifications', 'Quantity'],
    rows.length ? rows : [['1', docData.description || 'Printing Services', '1 ' + (docData.unit || 'Job')]],
    {
      columnStyles: {
        0: {cellWidth: 16, halign: 'center'},
        1: {cellWidth: width - 28 - 16 - 35},
        2: {cellWidth: 35, halign: 'center', fontStyle: 'bold'},
      },
    }
  );

  const notes = [
    docData.notes ? 'Notes: ' + docData.notes : '',
    'Goods received in good condition and order. Any discrepancies must be reported upon delivery.',
  ].filter(Boolean).join('\n');
  table(null, [[notes]]);

  y = Math.max(y + 16, doc.internal.pageSize.getHeight() - 38);
  table(null, [[
    '\n\n___________________________\nReceiver\'s Signature & Date',
    'For ' + (settings?.name || 'Company') + '\n\n___________________________\nAuthorised Signatory',
  ]], {
    theme: 'plain',
    columnStyles: {
      0: {cellWidth: (width - 28) / 2, halign: 'left'},
      1: {cellWidth: (width - 28) / 2, halign: 'right'},
    },
  });

  return new Uint8Array(doc.output('arraybuffer'));
}
