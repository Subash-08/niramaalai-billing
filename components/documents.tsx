'use client';

import { useState, useEffect, useRef, useDeferredValue } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  Printer,
  Download,
  ArrowUpRight,
  Check,
  FileText,
  AlertCircle,
  RotateCcw,
  Archive,
  MessageCircle,
} from 'lucide-react';
import { uploadFile } from '@/lib/upload';
import {
  Bill,
  Line,
  Purchase,
  TODAY,
  uid,
  totals,
  lineTotal,
  roundedTotal,
  money,
  balance,
  paid,
  dateLabel,
  activeReservation,
  State,
} from '@/lib/domain';
import { ProductForm } from './inventory';
import { assertOpen, nextDate } from '@/lib/closing';
import { issueBill, receivePurchase, addPayment } from '@/lib/operations';
import { useStore } from './store';
import { PageHead, Card, Btn, Field, Modal, SearchBox, Empty, Badge, csvDownload } from './ui';
import { PaymentDialog } from './payments';
import SearchSelect from './search-select';
import DeliveryChallanModal from './delivery-challan-modal';
import { Truck } from 'lucide-react';
import { PersonForm } from './people';
import { InvoiceTemplate } from '@/lib/extensions';
import { TemplateInvoice as InvoicePaper, PrintDialog } from './templates';
import { mapPurchaseFromApi, mapInvoiceFromApi, mapQuotationFromApi, mapTemplateFromApi, mapProductFromApi, mapServiceFromApi } from '@/lib/mappers';
import {
  IssueInvoiceModal,
  InvoiceCancelModal,
} from './sales-modals';
import { RecordReceiptModal } from './payments';

export { InvoicePaper };

const blankLine = (): Line => ({
  productId: '',
  name: '',
  details: '',
  unit: 'Piece',
  printSpecifications: {},
  qty: 1,
  rate: 0,
  discount: 0,
  tax: 18,
  taxTreatment: 'Taxable',
  serials: [],
  hsn: '998713',
  warranty: 0,
  clientLineKey: uid('CLK'),
});

export function DocumentComposer({
  purchase = false,
  quotation = false,
  existingId,
}: {
  purchase?: boolean;
  quotation?: boolean;
  existingId?: string;
}) {
  const {
    state,
    run,
    notify,
    isLive,
    savePurchaseApi,
    confirmPurchaseOrderApi,
    receivePurchaseStockApi,
    recordReceiveShortcutApi,
    recordReceiveAndPayShortcutApi,
    fetchSuppliersPage,
    fetchProductsPage,
    fetchCustomersPage,
    saveQuotationApi,
    fetchQuotationDetailApi,
    saveInvoiceDraftApi,
    fetchInvoiceDetailApi,
    issueInvoiceApi,
    refreshMasterData,
  } = useStore();
  const router = useRouter();
  const params = useSearchParams();

  const editId = params.get('edit') || (existingId && existingId !== 'new' ? existingId : undefined);
  const [activeDraftId, setActiveDraftId] = useState<string | undefined>(editId);
  const isEditMode = !!editId;
  const isReceiptMode = purchase && !!existingId && existingId !== 'new';
  const [receiptLoaded, setReceiptLoaded] = useState(false);
  const receiptAttempt = useRef<{ key: string; fingerprint: string; date: string } | null>(null);
  const source = state.bills.find((b) => b.id === (params.get('from') || params.get('edit')));
  const existing = state.purchases.find((p) => p.id === (existingId || params.get('edit')));
  const job = state.jobs.find((j) => j.id === (params.get('job') || source?.jobId));
  const enquiry = state.enquiries.find((e) => e.id === params.get('enquiry'));

  const [loadedVersion, setLoadedVersion] = useState<number | undefined>((existing as any)?.version);
  const [loadedBillStatus, setLoadedBillStatus] = useState<string | undefined>((existing as any)?.billStatus);
  const isPosted = purchase && (existing?.billStatus === 'Posted' || loadedBillStatus === 'Posted');

  const [customerId, setCustomerId] = useState(
    existing?.supplierId || source?.customerId || job?.customerId || enquiry?.customerId || params.get('customer') || ''
  );
  const [lines, setLines] = useState<Line[]>(() => {
    if (existing) {
      return existing.lines.map((line: any) => ({
        ...line,
        clientLineKey: line.clientLineKey || uid('CLK'),
        qty: isReceiptMode ? Math.max(0, (line.quantityOrdered ?? line.qty) - (line.quantityReceived ?? 0) - (line.quantityCancelled ?? 0)) : (line.quantityOrdered ?? line.qty),
        serials: [],
      }));
    }
    if (source?.lines) {
      return source.lines.map((l: any) => ({
        ...l,
        clientLineKey: l.clientLineKey || uid('CLK'),
        serials: [],
      }));
    }
    if (job) {
      return [
        {
          ...blankLine(),
          name: job.work || job.problem,
          rate: Math.max(
            0,
            (job.final || job.estimate) -
            job.parts.reduce((a, x) => a + (state.products.find((p) => p.id === x.productId)?.price || 0) * x.qty, 0)
          ),
        },
        ...job.parts.map((part) => {
          const p = state.products.find((p) => p.id === part.productId)!;
          return { ...blankLine(), productId: p.id, name: p.name, qty: part.qty, rate: p.price, tax: p.tax, hsn: p.hsn };
        }),
      ];
    }
    return [];
  });

  const [date, setDate] = useState(TODAY);
  const [due, setDue] = useState(existing?.due || '2026-09-17');
  const [taxMode, setTaxMode] = useState<'Intra-state' | 'Inter-state'>(
    existing?.taxMode || source?.taxMode || 'Intra-state'
  );
  const [placeOfSupply, setPlaceOfSupply] = useState(
    existing?.placeOfSupply || source?.placeOfSupply || 'Tamil Nadu'
  );
  const [inclusive, setInclusive] = useState(existing?.inclusive ?? source?.inclusive ?? true);
  const [notes, setNotes] = useState(existing?.notes || source?.notes || '');
  const [category, setCategory] = useState<Bill['category']>('New goods');
  const service = false;
  const [ref, setRef] = useState(existing?.reference || '');
  const [product, setProduct] = useState('');
  const [search, setSearch] = useState('');
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierChoices, setSupplierChoices] = useState(state.suppliers);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerChoices, setCustomerChoices] = useState(state.customers);
  const [productChoices, setProductChoices] = useState(state.products);
  const [serviceChoices, setServiceChoices] = useState(state.serviceCatalog);
  const [selectedProductItem, setSelectedProductItem] = useState<any>(null);
  const [selectedServiceItem, setSelectedServiceItem] = useState<any>(null);
  const [serialIndex, setSerialIndex] = useState<number | null>(null);
  const [serialText, setSerialText] = useState('');
  const [newPerson, setNewPerson] = useState(false);
  const [review, setReview] = useState(false);
  const [newProduct, setNewProduct] = useState(false);
  const [serviceId, setServiceId] = useState('');
  const [payRows, setPayRows] = useState<{ account: string; amount: string; method: string }[]>([]);
  const [templateId, setTemplateId] = useState(source?.templateId || state.defaultTemplateId);
  const [printJobId, setPrintJobId] = useState(params.get('printJob') || (existing as any)?.printJobId || (source as any)?.printJobId || (existing as any)?.jobId || (source as any)?.jobId || '');
  const templateChosenByUser = useRef(false);
  useEffect(() => {
    // Initial demo state may render before live bootstrap completes. Only an
    // implicit selection follows the live default; explicit choices never switch.
    if (!templateChosenByUser.current && !source?.templateId && !params.get('edit') && !params.get('from')) {
      setTemplateId(state.defaultTemplateId || '');
    }
  }, [isLive, state.defaultTemplateId, source?.templateId, params]);
  const [shipSeparate, setShipSeparate] = useState(!!source?.shipTo);
  const [shipTo, setShipTo] = useState(
    source?.shipTo || { name: '', address: '', phone: '', state: 'Tamil Nadu', postalCode: '' }
  );
  // The address on a document is a snapshot. It may be corrected for this one
  // invoice without silently changing the customer's master record.
  const [billTo, setBillTo] = useState(
    source?.billTo || { name: '', address: '', phone: '', state: '', stateCode: '', postalCode: '' }
  );
  const [orderRef, setOrderRef] = useState('');
  const [deliveryNote, setDeliveryNote] = useState('');
  const [dispatch, setDispatch] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachmentFileId, setAttachmentFileId] = useState((existing as any)?.attachmentFileId || '');
  const [attachmentName, setAttachmentName] = useState('');
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  // Phase 3.5 & 4 Modals
  const [postModalOpen, setPostModalOpen] = useState(false);
  const [postInvoiceNumber, setPostInvoiceNumber] = useState('');
  const [postInvoiceDate, setPostInvoiceDate] = useState(TODAY);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payAccount, setPayAccount] = useState('Cash');
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [conflictMessage, setConflictMessage] = useState('');
  const [receiveShortcutKey, setReceiveShortcutKey] = useState(() => `record-receive-${uid('IDEM')}`);
  const [receivePayShortcutKey, setReceivePayShortcutKey] = useState(() => `record-receive-pay-${uid('IDEM')}`);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [issueTargetDraft, setIssueTargetDraft] = useState<{ id: string; version: number; totalPaise: number; customerId: string } | null>(null);

  const [id] = useState(
    existing?.id ||
    (quotation && params.get('edit') ? source?.id : undefined) ||
    `${purchase ? 'PUR' : quotation ? 'QUO' : service ? 'SVC' : 'INV'}-2026-${String(
      100 + state.bills.length + state.purchases.length + 1
    ).padStart(4, '0')}`
  );

  const person = purchase
    ? supplierChoices.find((c) => c.id === customerId) || state.suppliers.find((c) => c.id === customerId)
    : customerChoices.find((c) => c.id === customerId) || state.customers.find((c) => c.id === customerId);

  useEffect(() => {
    if (purchase || !person || billTo.name) return;
    const next = {
      name: person.name || '',
      address: person.address || '',
      phone: person.phone || '',
      state: (person as any)?.details?.state || (person as any)?.state || '',
      stateCode: (person as any)?.stateCode || '',
      postalCode: (person as any)?.details?.postalCode || (person as any)?.postalCode || '',
    };
    setBillTo(next);
    if (!shipSeparate && next.state) setPlaceOfSupply(next.state);
  }, [purchase, person?.id, billTo.name, shipSeparate]);

  const bill: Bill = {
    id,
    customerId,
    date,
    due,
    kind: quotation ? 'Quotation' : service ? 'Service' : 'Sale',
    category,
    status: quotation ? 'Draft' : 'Issued',
    lines,
    inclusive,
    taxMode,
    placeOfSupply,
    notes,
    profit: null,
    templateId,
    billTo,
    shipTo: shipSeparate ? shipTo : undefined,
    orderRef,
    deliveryNote,
    dispatch,
    jobId: service ? job?.id : undefined,
    enquiryId: source?.enquiryId || enquiry?.id,
    sourceId: quotation ? undefined : source?.id,
  };

  const doc: Purchase = {
    id,
    supplierId: customerId,
    date,
    due,
    reference: ref,
    status: 'Ordered',
    lines: lines.map((l: any) => ({
      ...l,
      clientLineKey: l.clientLineKey || uid('CLK'),
    })),
    inclusive,
    taxMode,
    placeOfSupply,
    notes,
    attachmentFileId: attachmentFileId || undefined,
  };

  const sum = totals(bill);

  useEffect(() => {
    if (!purchase || !isLive) return;
    const timer = window.setTimeout(() => {
      fetchSuppliersPage({ limit: 50, q: supplierSearch.trim() || undefined }).then(result => setSupplierChoices(result.records)).catch(() => { });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [purchase, isLive, supplierSearch, fetchSuppliersPage]);

  useEffect(() => {
    if (purchase || !isLive) return;
    const timer = window.setTimeout(() => {
      fetchCustomersPage({ limit: 50, q: customerSearch.trim() || undefined, status: 'Active' }).then(result => setCustomerChoices(result.records)).catch(() => { });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [purchase, isLive, customerSearch, fetchCustomersPage]);

  useEffect(() => {
    if (!isLive) return;
    const timer = window.setTimeout(() => {
      fetchProductsPage({ limit: 50, q: search.trim() || undefined, status: 'Active' }).then(result => setProductChoices(result.records)).catch(() => { });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isLive, search, fetchProductsPage]);

  const reloadLatestDraft = async () => {
    const fromId = params.get('from');
    if (!editId && !fromId) return;
    const loadId = editId || fromId;
    if (!loadId) return;
    try {
      if (purchase) {
        setReceiptLoaded(false);
        const res = await fetch(`/api/purchases/${encodeURIComponent(loadId)}`);
        if (!res.ok) throw new Error('Failed to load purchase draft.');
        const data = await res.json();
        const p = data.purchase || data;
        setLoadedVersion(p.version);
        setLoadedBillStatus(p.billStatus);
        if (p.supplierId) setCustomerId(p.supplierId);
        if (!isReceiptMode && (p.orderDate || p.date)) setDate(p.orderDate || p.date);
        if (p.dueDate || p.due) setDue(p.dueDate || p.due);
        if (p.taxMode) setTaxMode(p.taxMode);
        if (p.placeOfSupply) setPlaceOfSupply(p.placeOfSupply);
        if (p.inclusive !== undefined) setInclusive(p.inclusive);
        if (p.notes !== undefined) setNotes(p.notes);
        if (p.supplierInvoiceNumber || p.reference) setRef(p.supplierInvoiceNumber || p.reference);
        if (p.attachmentFileId) setAttachmentFileId(p.attachmentFileId);
        const mapped = mapPurchaseFromApi(p);
        setLines(mapped.lines.map((line: any) => ({
          ...line,
          qty: isReceiptMode ? Math.max(0, line.quantityOrdered - line.quantityReceived - line.quantityCancelled) : line.quantityOrdered,
          serials: [],
        })));
        setReceiptLoaded(true);
        notify('Reloaded latest purchase draft.');
      } else if (quotation) {
        const data = await fetchQuotationDetailApi(loadId);
        const q = data.quotation || data;
        setCategory(q.invoiceKind === 'Service' || q.businessCategory === 'Service' ? 'Service' : q.businessCategory === 'UsedGoods' ? 'Used goods' : 'New goods');
        setLoadedVersion(q.version);
        if (q.customerId) setCustomerId(q.customerId);
        if (q.quotationDate || q.date) setDate(q.quotationDate || q.date);
        if (q.validUntil || q.due) setDue(q.validUntil || q.due);
        if (q.taxMode) setTaxMode(q.taxMode);
        if (q.placeOfSupply) setPlaceOfSupply(q.placeOfSupply);
        if (q.billTo) setBillTo(q.billTo);
        if (q.shipTo) { setShipSeparate(true); setShipTo(q.shipTo); } else setShipSeparate(false);
        if (q.inclusive !== undefined) setInclusive(q.inclusive);
        if (q.notes !== undefined) setNotes(q.notes);
        if (q.templateId) setTemplateId(q.templateId);
        if (q.orderReference) setOrderRef(q.orderReference);
        if (q.lines?.length) {
          setLines(q.lines.map((l: any) => ({
            ...blankLine(),
            productId: l.productId || '',
            name: l.name || l.description || '',
            qty: l.qty ?? l.quantity ?? 1,
            rate: l.rate ?? (l.unitRatePaise ? l.unitRatePaise / 100 : 0),
            discount: l.discount ?? (l.discountValue ? l.discountValue / 100 : 0),
            discountType: l.discountType || 'Percentage',
            tax: l.tax ?? (l.taxBasisPoints ? l.taxBasisPoints / 100 : 0),
            taxTreatment: l.taxTreatment || 'Taxable',
            hsn: l.hsn || '',
            sac: l.sac || '',
            warranty: l.warranty ?? l.warrantyMonths ?? 0,
            lineType: l.lineType || 'Product',
            stockAllocations: l.stockAllocations || [],
            serials: l.serials || [],
            clientLineKey: l.clientLineKey || uid('CLK'),
          })));
        }
        notify('Loaded quotation details.');
      } else {
        if (fromId) {
          const data = await fetchQuotationDetailApi(fromId);
          const q = data.quotation || data;
          setCategory(q.invoiceKind === 'Service' || q.businessCategory === 'Service' ? 'Service' : q.businessCategory === 'UsedGoods' ? 'Used goods' : 'New goods');
          if (q.customerId) setCustomerId(q.customerId);
          if (q.taxMode) setTaxMode(q.taxMode);
          if (q.placeOfSupply) setPlaceOfSupply(q.placeOfSupply);
          if (q.billTo) setBillTo(q.billTo);
          if (q.shipTo) { setShipSeparate(true); setShipTo(q.shipTo); } else setShipSeparate(false);
          if (q.inclusive !== undefined) setInclusive(q.inclusive);
          if (q.notes !== undefined) setNotes(q.notes);
          if (q.templateId) setTemplateId(q.templateId);
          if (q.lines?.length) {
            setLines(q.lines.map((l: any) => ({
              ...blankLine(),
              productId: l.productId || '',
              serviceId: l.serviceId || '',
              name: l.name || l.description || '',
              details: l.details || '',
              unit: l.unit || 'Piece',
              printSpecifications: l.printSpecifications || {},
              qty: l.qty ?? l.quantity ?? 1,
              rate: l.rate ?? (l.unitRatePaise ? l.unitRatePaise / 100 : 0),
              discount: l.discount ?? (l.discountValue ? l.discountValue / 100 : 0),
              discountType: l.discountType || 'Percentage',
              tax: l.tax ?? (l.taxBasisPoints ? l.taxBasisPoints / 100 : 0),
              taxTreatment: l.taxTreatment || 'Taxable',
              hsn: l.hsn || l.sac || '',
              sac: l.sac || '',
              warranty: l.warranty ?? l.warrantyMonths ?? 0,
              lineType: l.lineType || 'Product',
              stockAllocations: [],
              serials: [],
              clientLineKey: uid('CLK'),
            })));
          }
          notify('Loaded items from quotation.');
        } else if (editId) {
          const data = await fetchInvoiceDetailApi(editId);
          const inv = data.invoice || data;
          setLoadedVersion(inv.version);
          setLoadedBillStatus(inv.status);
          if (inv.customerId) setCustomerId(inv.customerId);
          if (inv.invoiceDate || inv.date) setDate(inv.invoiceDate || inv.date);
          if (inv.dueDate || inv.due) setDue(inv.dueDate || inv.due);
          if (inv.taxMode) setTaxMode(inv.taxMode);
          if (inv.placeOfSupply) setPlaceOfSupply(inv.placeOfSupply);
          if (inv.billTo) setBillTo(inv.billTo);
          if (inv.shipTo) { setShipSeparate(true); setShipTo(inv.shipTo); } else setShipSeparate(false);
          if (inv.inclusive !== undefined) setInclusive(inv.inclusive);
          if (inv.notes !== undefined) setNotes(inv.notes);
          if (inv.templateId) setTemplateId(inv.templateId);
          if (inv.orderReference) setOrderRef(inv.orderReference);
          if (inv.deliveryNote) setDeliveryNote(inv.deliveryNote);
          if (inv.dispatchThrough) setDispatch(inv.dispatchThrough);
          if (inv.printJobId || inv.jobId) setPrintJobId(inv.printJobId || inv.jobId);
          if (inv.lines?.length) {
            setLines(inv.lines.map((l: any) => ({
              ...blankLine(),
              productId: l.productId || '',
              serviceId: l.serviceId || '',
              name: l.name || l.description || '',
              details: l.details || '',
              unit: l.unit || 'Piece',
              printSpecifications: l.printSpecifications || {},
              qty: l.qty ?? l.quantity ?? 1,
              rate: l.rate ?? (l.unitRatePaise ? l.unitRatePaise / 100 : 0),
              discount: l.discount ?? (l.discountValue ? l.discountValue / 100 : 0),
              discountType: l.discountType || 'Percentage',
              tax: l.tax ?? (l.taxBasisPoints ? l.taxBasisPoints / 100 : 0),
              taxTreatment: l.taxTreatment || 'Taxable',
              hsn: l.hsn || l.sac || '',
              sac: l.sac || '',
              warranty: l.warranty ?? l.warrantyMonths ?? 0,
              lineType: l.lineType || (l.serviceId ? 'Service' : 'Product'),
              stockAllocations: l.stockAllocations || [],
              serials: l.stockAllocations?.flatMap((a: any) => a.serials || []) || l.serials || [],
              clientLineKey: l.clientLineKey || uid('CLK'),
            })));
          }
          notify('Reloaded latest invoice draft.');
        }
      }
    } catch (err: any) {
      notify(err.message || 'Could not reload document details.');
    }
  };

  useEffect(() => {
    if (isLive && (isEditMode || (!purchase && params.get('from')))) {
      reloadLatestDraft();
    } else if (isLive && !purchase && params.get('printJob') && !isEditMode) {
      const printJobId = params.get('printJob')!;
      fetch(`/api/print-jobs/${encodeURIComponent(printJobId)}`)
        .then((r) => r.json())
        .then((data) => {
          const j = data.job || data;
          // If this job already has a linked invoice, open it instead
          if (j.invoiceId) {
            router.replace('/sales/' + j.invoiceId);
            return;
          }
          if (j.customerId) setCustomerId(j.customerId);
          setPrintJobId(j._id || printJobId);
          const specs: Record<string, string> = {};
          if (j.specifications?.size) specs.size = j.specifications.size;
          if (j.specifications?.material) specs.material = j.specifications.material;
          if (j.specifications?.gsm) specs.gsm = j.specifications.gsm;
          if (j.specifications?.colour) specs.colour = j.specifications.colour;
          if (j.specifications?.sides) specs.sides = j.specifications.sides;
          if (j.specifications?.finishing) specs.finishing = j.specifications.finishing;
          if (j.dueDate) specs.deliveryDate = j.dueDate;
          if (j.notes) specs.notes = j.notes;
          setLines([
            {
              ...blankLine(),
              lineType: 'Charge',
              name: j.title || 'Print job',
              details: j.description || '',
              unit: j.unit || 'Job',
              qty: j.quantity || 1,
              printSpecifications: specs,
              hsn: '998912',
              clientLineKey: uid('CLK'),
            } as any,
          ]);
          notify('Loaded print job details. Set the price and issue the invoice.');
        })
        .catch(() => {});
    } else if (isLive && !purchase && params.get('job') && !isEditMode) {
      const jobId = params.get('job')!;
      fetch(`/api/services/${encodeURIComponent(jobId)}`)
        .then((r) => r.json())
        .then((data) => {
          const j = data.job || data;
          if (j.customerId) setCustomerId(j.customerId);
          setCategory('Service');
          const serviceLines: Line[] = [];
          const labourPaise = j.estimate?.estimatedCostPaise || 0;
          serviceLines.push({
            ...blankLine(),
            name: `${j.device?.brand || ''} ${j.device?.model || ''} - Repair Service: ${j.reportedProblem || 'Service Work'}`.trim(),
            qty: 1,
            rate: labourPaise ? labourPaise / 100 : 0,
            lineType: 'Service',
            sac: '998713',
            serviceJobId: j._id,
            clientLineKey: uid('CLK'),
          });
          for (const p of (j.parts || [])) {
            if (p.reversed) continue;
            serviceLines.push({
              ...blankLine(),
              productId: p.productId,
              partId: p.partId,
              name: p.productName,
              qty: p.quantity,
              rate: (p.billingRatePaise || p.unitCostPaise || 0) / 100,
              tax: (p.taxBasisPoints || 1800) / 100,
              hsn: p.hsn || '847330',
              lineType: 'ConsumedPart',
              serviceJobId: j._id,
              serials: p.serials || [],
              clientLineKey: uid('CLK'),
            });
          }
          setLines(serviceLines);
          notify('Loaded service job details and consumed parts.');
        })
        .catch(() => { });
    }
  }, [isLive, isEditMode, editId]);

  function update(i: number, k: keyof Line, v: unknown) {
    if (isReceiptMode && k !== 'qty' && k !== 'serials') return;
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, [k]: v, ...(k === 'qty' ? { serials: [] } : {}) } : l)));
  }

  function updatePrintSpecification(i: number, key: string, value: string) {
    setLines((current) => current.map((line, index) => index === i
      ? {...line, printSpecifications: {...(line.printSpecifications || {}), [key]: value}}
      : line));
  }

  async function uploadPurchaseAttachment(file?: File) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return notify('Attachment must be 5 MB or smaller.');
    setUploadingAttachment(true);
    try {
      const data = await uploadFile(file);
      setAttachmentFileId(data._id || data.id);
      setAttachmentName(file.name);
      notify('Supplier document attached.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Attachment upload failed.');
    } finally {
      setUploadingAttachment(false);
    }
  }

  function addProduct() {
    if (isReceiptMode) {
      notify('Receive products already on this purchase. Create a separate purchase for additional items.');
      return;
    }
    const p = productChoices.find((p) => p.id === product) || state.products.find((p) => p.id === product);
    if (!p) return;
    if (lines.some((l) => l.productId === p.id && l.lineType !== 'Charge')) {
      notify('This product is already added. Change its quantity in the row.');
      return;
    }
    setLines((ls) => [
      ...ls,
      {
        ...blankLine(),
        productId: p.id,
        lineType: 'Product',
        name: p.name,
        details: p.description || '',
        unit: p.unit || 'Piece',
        qty: 1,
        rate: purchase
          ? inclusive
            ? p.cost
            : p.cost / (1 + p.tax / 100)
          : inclusive
            ? p.price
            : Math.round((p.price / (1 + p.tax / 100)) * 100) / 100,
        discount: 0,
        tax: p.tax,
        serials: [],
        isSerialTracked: p.isSerialTracked,
        hsn: p.hsn,
        warranty: p.warranty,
        clientLineKey: uid('CLK'),
      } as any,
    ]);
    if (p.condition === 'Used' && lines.length === 0) setCategory('Used goods');
    setProduct('');
  }

  function reorder(i: number, dir: number) {
    const next = [...lines];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    setLines(next);
  }

  function validateBasic(): boolean {
    if (!purchase && (!billTo.name.trim() || !billTo.address.trim() || !billTo.state.trim())) {
      notify('Enter the bill-to name, address and state for this document.');
      return false;
    }
    if (shipSeparate && (!shipTo.name.trim() || !shipTo.address.trim() || !shipTo.state.trim())) {
      notify('Enter the ship-to name, address and state, or use the billing address.');
      return false;
    }
    if (!purchase) {
      const sellerState = (state.settings.state || '').trim().toLocaleLowerCase();
      const destinationState = (shipSeparate ? shipTo.state : billTo.state || placeOfSupply).trim().toLocaleLowerCase();
      if (!placeOfSupply.trim()) {
        notify('Enter the place of supply.');
        return false;
      }
      if (sellerState && destinationState && taxMode === 'Inter-state' && sellerState === destinationState) {
        notify('Interstate supply needs a destination outside the shop state. Choose Within state for CGST + SGST.');
        return false;
      }
      if (sellerState && destinationState && taxMode === 'Intra-state' && sellerState !== destinationState) {
        notify('A destination outside the shop state needs Interstate / IGST.');
        return false;
      }
    }
    if (
      !person ||
      !lines.length ||
      lines.some(
        (l) =>
          typeof l.name !== 'string' || !l.name.trim() ||
          ![l.qty, l.rate, l.discount, l.tax].every(Number.isFinite) ||
          l.qty <= 0 ||
          !Number.isInteger(l.qty) ||
          l.rate < 0 ||
          l.discount < 0 ||
          l.discount > (l.discountType === 'Amount' ? l.qty * l.rate : 100) ||
          l.tax < 0 ||
          l.tax > 100
      ) ||
      due < date
    ) {
      notify('Choose a customer/supplier, add valid items and check the due date.');
      return false;
    }
    return true;
  }

  async function handlePurchaseAction(action: 'draft' | 'confirm' | 'post' | 'receive' | 'receive_pay') {
    if (busy) return;
    // Receiving is independent of bill editing and payment. No due-date or rate
    // validation is needed; the server owns the original purchase snapshot.
    if (isReceiptMode) {
      if (!editId || !receiptLoaded) { notify('Wait for the purchase to load, or reload it before receiving.'); return; }
      const productLines = lines.filter(line => line.lineType !== 'Charge');
      for (const line of productLines as any[]) {
        const remaining = line.quantityOrdered - line.quantityReceived - line.quantityCancelled;
        if (!line.lineId || !Number.isInteger(line.qty) || line.qty < 0 || line.qty > remaining) {
          notify('Enter a whole quantity between zero and the remaining quantity for each product.'); return;
        }
        if (line.qty > 0 && (line.isSerialTracked ? line.serials.length !== line.qty : line.serials.length !== 0)) {
          notify(line.isSerialTracked ? `Enter ${line.qty} serial numbers for ${line.name}.` : `${line.name} does not track serial numbers.`); return;
        }
      }
      const receiptLines = productLines.filter(line => line.qty > 0).map((line: any) => ({
        lineId: line.lineId, quantityReceived: line.qty, serials: line.serials || [],
      }));
      if (!receiptLines.length) { notify('Enter a quantity to receive for at least one product.'); return; }
      const fingerprint = JSON.stringify(receiptLines);
      if (receiptAttempt.current && receiptAttempt.current.fingerprint !== fingerprint) {
        notify('The previous receipt attempt has different quantities. Reopen the purchase and check its receipt history before submitting a changed receipt.'); return;
      }
      receiptAttempt.current ??= {
        key: `receipt-${crypto.randomUUID()}`, fingerprint,
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
      };
      setBusy(true);
      try {
        const ok = await receivePurchaseStockApi(editId, receiptLines, {
          idempotencyKey: receiptAttempt.current.key, receiptDate: receiptAttempt.current.date,
        });
        if (ok) { notify('Stock received. No supplier payment was recorded; any unpaid amount remains due.'); router.push('/purchases/' + editId); }
      } catch (error: unknown) {
        notify(error instanceof Error ? error.message : 'Unable to receive stock.');
      } finally { setBusy(false); }
      return;
    }
    if (!validateBasic()) return;

    if (!isLive) {
      // Fallback in-memory
      const ok = run((s) => {
        let next: State = s;
        assertOpen(s, date);
        if (action === 'post' || action === 'receive' || action === 'receive_pay') {
          next = receivePurchase(s, doc);
        } else {
          if (s.purchases.some((p) => p.id === id)) throw new Error('Purchase number already exists.');
          next = { ...s, purchases: [doc, ...s.purchases] };
        }
        return next;
      }, 'Purchase updated.');
      if (ok) router.push('/purchases/' + id);
      return;
    }

    setBusy(true);
    try {
      if (action === 'draft') {
        const res = await savePurchaseApi(doc, false, isEditMode ? editId : undefined, isEditMode ? loadedVersion : undefined);
        if (res.success) {
          notify('Purchase draft saved.');
          router.push('/purchases/' + (res.purchase?._id || res.purchase?.id || id));
        } else {
          if (res.error?.includes('conflict') || res.error?.includes('version') || res.error?.includes('409')) {
            setConflictMessage(res.error);
            setConflictModalOpen(true);
          } else {
            notify(res.error || 'Failed to save purchase draft.');
          }
        }
      } else if (action === 'confirm') {
        const saveRes = await savePurchaseApi(doc, false);
        if (!saveRes.success) {
          notify(saveRes.error || 'Failed to save purchase order.');
          return;
        }
        const purId = saveRes.purchase?._id || saveRes.purchase?.id || id;
        const confRes = await confirmPurchaseOrderApi(purId, saveRes.purchase?.version || 1);
        if (confRes.success) {
          notify('Purchase order confirmed.');
          router.push('/purchases/' + purId);
        } else {
          notify(confRes.error || 'Saved as draft, but could not confirm order.');
          router.push('/purchases/' + purId);
        }
      } else if (action === 'post') {
        if (!postInvoiceNumber && ref) setPostInvoiceNumber(ref);
        setPostModalOpen(true);
      } else if (action === 'receive') {
        if (!ref.trim()) {
          notify('Enter the supplier invoice number before recording and receiving stock.');
          return;
        }
        const receiptLines = lines
          .filter((l: any) => l.lineType !== 'Charge')
          .map((l: any) => ({
            clientLineKey: l.clientLineKey,
            quantityReceived: l.qty,
            serials: l.serials || [],
          }));
        const res = await recordReceiveShortcutApi({
          purchase: { ...doc, supplierInvoiceNumber: ref.trim(), supplierInvoiceDate: postInvoiceDate },
          receiptLines,
          supplierInvoiceNumber: ref.trim(),
          supplierInvoiceDate: postInvoiceDate,
          idempotencyKey: receiveShortcutKey,
        });
        if (res.success) {
          setReceiveShortcutKey(`record-receive-${uid('IDEM')}`);
          notify('Purchase created and stock received.');
          router.push('/purchases/' + (res.purchase?._id || res.purchase?.id || id));
        } else {
          notify(res.error || 'Failed to record and receive purchase.');
        }
      } else if (action === 'receive_pay') {
        if (!postInvoiceNumber && ref) setPostInvoiceNumber(ref);
        setPayModalOpen(true);
      }
    } catch (error: unknown) {
      notify(error instanceof Error ? error.message : 'Unable to save purchase.');
    } finally {
      setBusy(false);
    }
  }

  async function submitPostModal(e: React.FormEvent) {
    e.preventDefault();
    if (!postInvoiceNumber.trim()) return notify('Enter the supplier invoice number.');
    setBusy(true);
    try {
      const res = await savePurchaseApi(
        {
          ...doc,
          reference: postInvoiceNumber.trim(),
          supplierInvoiceDate: postInvoiceDate,
        },
        true
      );
      if (res.success) {
        setPostModalOpen(false);
        notify('Supplier bill posted.');
        router.push('/purchases/' + (res.purchase?._id || res.purchase?.id || id));
      } else {
        notify(res.error || 'Failed to post supplier bill.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitReceiveAndPay(e: React.FormEvent) {
    e.preventDefault();
    if (!postInvoiceNumber.trim()) return notify('Enter the supplier invoice number.');
    setBusy(true);
    try {
      const receiptLines = lines
        .filter((l: any) => l.lineType !== 'Charge')
        .map((l: any) => ({
          clientLineKey: l.clientLineKey,
          quantityReceived: l.qty,
          serials: l.serials || [],
        }));
      const res = await recordReceiveAndPayShortcutApi({
        purchase: {
          ...doc,
          reference: postInvoiceNumber.trim(),
          supplierInvoiceDate: postInvoiceDate,
        },
        receiptLines,
        payment: {
          components: [{
            amountPaise: Math.round(sum.total * 100),
            account: payAccount === 'Cash' ? 'Cash' : 'Bank',
            method: payAccount === 'Cash' ? 'Cash' : 'BankTransfer',
            reference: '',
          }],
          recordExcessAsAdvance: false,
          notes: '',
        },
        supplierInvoiceNumber: postInvoiceNumber.trim(),
        supplierInvoiceDate: postInvoiceDate,
        idempotencyKey: receivePayShortcutKey,
      });
      if (res.success) {
        setReceivePayShortcutKey(`record-receive-pay-${uid('IDEM')}`);
        setPayModalOpen(false);
        notify('Purchase created, stock received, and payment settled.');
        router.push('/purchases/' + (res.purchase?._id || res.purchase?.id || id));
      } else {
        notify(res.error || 'Failed to record receive and pay.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSalesAction(action: 'save_draft' | 'issue') {
    if (busy) return;
    if (action === 'issue' && payRows.some(p => !/^\d+(?:\.\d{1,2})?$/.test(p.amount.trim()) || Number(p.amount) <= 0)) {
      notify('Enter a positive payment amount with up to two decimal places, or remove the unused payment row for credit.');
      return;
    }
    if (!validateBasic()) return;

    if (!isLive) {
      return saveSales();
    }


    setBusy(true);
    try {
      let templateRecord: InvoiceTemplate | undefined;
      if (templateId) {
        templateRecord = state.templates.find((t) => t.id === templateId);
        if (!templateRecord || templateRecord.status === 'Archived') {
          try {
            const tRes = await fetch(`/api/master/templates/${encodeURIComponent(templateId)}`);
            if (tRes.ok) {
              const tDoc = await tRes.json();
              templateRecord = mapTemplateFromApi(tDoc);
            }
          } catch { }
        }
        if (!templateRecord || templateRecord.status === 'Archived') {
          notify('The selected invoice template is unavailable or archived. Please select an active template.');
          setBusy(false);
          return;
        }
      } else {
        templateRecord = state.templates.find((t) => t.id === state.defaultTemplateId && t.status !== 'Archived')
          || state.templates.find((t) => t.status !== 'Archived');
        if (!templateRecord) {
          notify('No active invoice template is available. Please configure an invoice template.');
          setBusy(false);
          return;
        }
      }

      let chosenTemplateRev = templateRecord.currentRevision ?? templateRecord.revision;
      if (typeof chosenTemplateRev !== 'number' || chosenTemplateRev < 1) {
        try {
          const tRes = await fetch(`/api/master/templates/${encodeURIComponent(templateRecord.id)}`);
          if (tRes.ok) {
            const tDoc = await tRes.json();
            const reloaded = mapTemplateFromApi(tDoc);
            chosenTemplateRev = reloaded.currentRevision ?? reloaded.revision;
          }
        } catch { }
      }

      if (typeof chosenTemplateRev !== 'number' || chosenTemplateRev < 1) {
        notify(`Template configuration error: revision information is missing for template "${templateRecord.name}". Please reload or edit the template.`);
        setBusy(false);
        return;
      }

      const chosenTemplateId = templateRecord.id;

      const linesPayload = lines.map((l: Line) => {
        const isSvc = l.lineType === 'Service';
        const isChg = l.lineType === 'Charge' || (!l.lineType && !l.productId);
        const isConsumed = l.lineType === 'ConsumedPart';
        const treatment = (l.taxTreatment || 'Taxable') as 'Taxable' | 'Exempt' | 'NonGST';
        const isZeroTax = treatment === 'Exempt' || treatment === 'NonGST';
        const common = {
          clientLineKey: l.clientLineKey || uid('CLK'),
          description: (l.name || 'Item').trim(),
          details: (l.details || '').trim(),
          unit: l.unit || (isSvc ? 'Job' : 'Piece'),
          printSpecifications: l.printSpecifications || {},
          quantity: Math.max(1, Math.round(l.qty || 1)),
          unitRatePaise: Math.round((l.rate || 0) * 100),
          discountType: (l.discountType || 'Percentage') as 'Percentage' | 'Amount',
          discountValue: Math.round((l.discount || 0) * 100),
          taxBasisPoints: isZeroTax ? 0 : Math.round((l.tax || 0) * 100),
          taxTreatment: treatment,
        };

        if (isChg) {
          return {
            ...common,
            lineType: 'Charge' as const,
            sac: l.sac || l.hsn || '998713',
          };
        }
        if (isSvc) {
          return {
            ...common,
            lineType: 'Service' as const,
            serviceId: l.serviceId || undefined,
            sac: l.sac || l.hsn || '998713',
            serviceJobId: l.serviceJobId || (service ? job?.id : undefined),
            warrantyMonths: Number(l.warranty || 0),
          };
        }
        if (isConsumed) {
          return {
            ...common,
            lineType: 'ConsumedPart' as const,
            serviceJobId: l.serviceJobId || params.get('job') || job?.id || '',
            partId: (l as any).partId || '',
            productId: l.productId,
            lotId: (l as any).lotId || undefined,
            hsn: l.hsn || '847330',
            serials: l.serials || [],
            warrantyMonths: Number(l.warranty || 0),
          };
        }
        return {
          ...common,
          lineType: 'Product' as const,
          productId: l.productId,
          hsn: l.hsn || '',
          stockAllocations: [],
          warrantyMonths: 0,
        };
      });

      if (quotation) {
        const payload = {
          idempotencyKey: `quote-save-${uid('IDEM')}`,
          customerId,
          invoiceKind: (category === 'Service' ? 'Service' : 'Sale') as 'Sale' | 'Service',
          businessCategory: (category === 'Used goods' ? 'UsedGoods' : category === 'Service' ? 'Service' : 'NewGoods') as any,
          quotationDate: date,
          validUntil: due >= date ? due : date,
          inclusive: !!inclusive,
          taxMode,
          placeOfSupply,
          billTo,
          shipTo: shipSeparate ? shipTo : undefined,
          templateId: chosenTemplateId,
          templateRevision: chosenTemplateRev,
          orderReference: orderRef.trim(),
          notes: notes.trim(),
          serviceJobId: params.get('job') || (job as any)?._id || (job as any)?.id || undefined,
          sourceEnquiryId: params.get('enquiry') || (enquiry as any)?._id || (enquiry as any)?.id || undefined,
          lines: linesPayload,
        };

        const res = await saveQuotationApi(payload, editId, loadedVersion);
        if (res.success) {
          notify('Quotation saved successfully.');
          const quoteId = res.quotation?._id || res.quotation?.id || id;
          router.push('/quotations/' + quoteId);
        } else {
          notify(res.error || 'Failed to save quotation.');
        }
        return;
      }

      // Sales Invoice Draft
      const invoicePayload = {
        idempotencyKey: `inv-save-${uid('IDEM')}`,
        customerId,
        invoiceKind: 'Sale' as const,
        businessCategory: 'NewGoods' as const,
        invoiceDate: date,
        dueDate: due >= date ? due : date,
        inclusive: !!inclusive,
        taxMode,
        placeOfSupply,
        billTo,
        shipTo: shipSeparate ? shipTo : undefined,
        templateId: chosenTemplateId,
        templateRevision: chosenTemplateRev,
        orderReference: orderRef.trim(),
        deliveryNote: deliveryNote.trim(),
        dispatchThrough: dispatch.trim(),
        notes: notes.trim(),
        printJobId: printJobId || undefined,
        sourceQuotationId: params.get('from') || undefined,
        serviceJobId: params.get('job') || (job as any)?._id || (job as any)?.id || undefined,
        enquiryId: params.get('enquiry') || (enquiry as any)?._id || (enquiry as any)?.id || undefined,
        lines: linesPayload,
      };

      const targetDraftId = activeDraftId || editId;
      const res = await saveInvoiceDraftApi(invoicePayload, targetDraftId, loadedVersion);
      if (!res.success) {
        notify(res.error || 'Failed to save invoice draft.');
        return;
      }

      const draftObj = res.draft || {};
      const draftId = draftObj._id || draftObj.id || targetDraftId || id;
      const draftVer = draftObj.version || (loadedVersion ? loadedVersion + 1 : 1);
      const draftTotalPaise = draftObj.totalPaise || Math.round(sum.total * 100);

      setActiveDraftId(draftId);
      setLoadedVersion(draftVer);

      if (action === 'save_draft') {
        notify('Invoice draft saved.');
        router.push('/sales/' + draftId);
      } else if (action === 'issue') {
        setIssueTargetDraft({
          id: draftId,
          version: draftVer,
          totalPaise: draftTotalPaise,
          customerId,
        });
        setIssueModalOpen(true);
      }
    } finally {
      setBusy(false);
    }
  }

  function saveSales(receive = false) {
    if (!validateBasic()) return;
    if (payRows.some((p) => !Number.isFinite(+p.amount) || +p.amount <= 0)) {
      notify('Enter a positive payment amount or remove the unused payment row.');
      return;
    }
    const ok = run((s) => {
      let next: State = s;
      next = issueBill(
        quotation && params.get('edit') ? { ...s, bills: s.bills.filter((b) => b.id !== id) } : s,
        bill
      );
      if (!quotation) {
        for (const p of payRows) {
          next = addPayment(next, {
            id: uid('PAY'),
            date,
            direction: 'In',
            account: p.account,
            amount: Number(p.amount),
            purpose: 'Customer payment',
            reference: id,
            party: customerId,
            note: p.method + ' · at creation',
          });
        }
      }
      return next;
    }, 'Invoice saved.');
    if (ok) router.push(`/sales/${id}`);
  }

  return (
    <>
      <Link className="back-link" href="/sales">
        <ArrowLeft size={14} />
        Back to invoices
      </Link>

      <PageHead
        title={
          isReceiptMode
            ? 'Receive stock — payment optional'
            : purchase
              ? 'New purchase'
              : quotation
                ? 'New quotation'
                : service
                  ? 'New service invoice'
                  : 'New sales invoice'
        }
        description={
          purchase
            ? (isReceiptMode ? 'Receive delivered goods into inventory. No money leaves Cash or Bank. Pay the supplier later from this purchase or the supplier profile.' : 'Record a supplier bill and receive goods without payment, or choose Record + Receive + Pay to pay now.')
            : quotation
              ? 'Prepare an estimate. Stock and money stay unchanged until a sale is confirmed.'
              : 'Add items, check the totals and issue the customer’s invoice.'
        }
        actions={
          <>
            <Btn secondary onClick={() => setReview(true)}>
              <FileText size={16} />
              Preview
            </Btn>
            {purchase ? (
              isReceiptMode ? (
                <Btn disabled={busy || !receiptLoaded} onClick={() => handlePurchaseAction('receive')}>
                  <Check size={16} />
                  Receive stock
                </Btn>
              ) : (
                <div className="composer-actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('draft')}>
                    Save draft
                  </Btn>
                  <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('confirm')}>
                    Confirm purchase order
                  </Btn>
                  <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('post')}>
                    Post supplier bill
                  </Btn>
                  <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('receive')}>
                    Record + Receive
                  </Btn>
                  <Btn disabled={busy} onClick={() => handlePurchaseAction('receive_pay')}>
                    <Check size={16} />
                    Record + Receive + Pay
                  </Btn>
                </div>
              )
            ) : (
              <div className="composer-actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {quotation ? (
                  <Btn disabled={busy} onClick={() => handleSalesAction('save_draft')}>
                    <Check size={16} /> Save quotation
                  </Btn>
                ) : (
                  <>
                    <Btn secondary disabled={busy} onClick={() => handleSalesAction('save_draft')}>
                      Save draft
                    </Btn>
                    <Btn disabled={busy} onClick={() => handleSalesAction('issue')}>
                      <Check size={16} /> Issue invoice
                    </Btn>
                  </>
                )}
              </div>
            )}
          </>
        }
      />

      <div className="stack">
        <Card
          title="Customer and document details"
          actions={
            <Btn secondary onClick={() => setNewPerson(true)}>
              <Plus size={14} />
              Add customer
            </Btn>
          }
        >
          <div className="form-body form-grid">
            <div className="field">
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                Customer *
              </label>
              <SearchSelect
                placeholder="Search customer by name, phone, GST..."
                value={customerId}
                selectedLabel={person?.name}
                options={(purchase ? supplierChoices : (isLive ? customerChoices : state.customers)).map((c: any) => ({
                  value: c.id,
                  label: c.name,
                  sublabel: `${c.phone}${c.gst ? ' · GST: ' + c.gst : ''}`,
                }))}
                onSearch={async (query, signal) => {
                  if (!isLive) {
                    const qLower = query.toLowerCase();
                    return state.customers
                      .filter((c: any) => c.name.toLowerCase().includes(qLower) || c.phone.includes(qLower) || (c.gst && c.gst.toLowerCase().includes(qLower)))
                      .map((c: any) => ({
                        value: c.id,
                        label: c.name,
                        sublabel: `${c.phone}${c.gst ? ' · GST: ' + c.gst : ''}`,
                      }));
                  }
                  const res = await fetch(`/api/master/customers?q=${encodeURIComponent(query)}&limit=30`, { signal });
                  if (!res.ok) return [];
                  const data = await res.json();
                  return (data.records || []).map((c: any) => ({
                    value: c._id || c.id,
                    label: c.name,
                    sublabel: `${c.phone}${c.gst ? ` · GST: ${c.gst}` : ''}`,
                    data: c,
                  }));
                }}
                onChange={(val) => {
                  setCustomerId(val);
                  const c = purchase
                    ? supplierChoices.find((x) => x.id === val) || state.suppliers.find((x) => x.id === val)
                    : customerChoices.find((x) => x.id === val) || state.customers.find((x) => x.id === val);
                  const days = purchase
                    ? (c as any)?.terms
                    : Number((c as any)?.details?.paymentTerms || 0);
                  setDue(nextDate(date, days || 0));
                  if (!purchase && c) {
                    const nextBillTo = {
                      name: c.name || '',
                      address: c.address || '',
                      phone: c.phone || '',
                      state: (c as any)?.details?.state || (c as any)?.state || '',
                      stateCode: (c as any)?.stateCode || '',
                      postalCode: (c as any)?.details?.postalCode || (c as any)?.postalCode || '',
                    };
                    setBillTo(nextBillTo);
                    if (!shipSeparate) setPlaceOfSupply(nextBillTo.state || state.settings.state || '');
                  }
                }}
              />
            </div>

            {!purchase && (
              <Field label="Invoice layout / template">
                <select
                  value={templateId}
                  onChange={(e) => {
                    templateChosenByUser.current = true;
                    setTemplateId(e.target.value);
                  }}
                >
                  <option value="">Select a saved template</option>
                  {state.templates.filter(t => !isLive || t.status === 'Active').map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {isLive && state.templates.filter(t => t.status === 'Active').length === 0 ? (
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                    <span style={{ color: '#d97706', fontSize: '0.85rem' }}>No saved templates found.</span>
                    <Link className="text-link" href="/templates" target="_blank" rel="noopener noreferrer">
                      Create template (opens new tab)
                    </Link>
                    <button
                      type="button"
                      className="link-button"
                      style={{ fontSize: '0.85rem', color: 'var(--primary)' }}
                      onClick={async () => {
                        await refreshMasterData();
                        notify('Templates refreshed.');
                      }}
                    >
                      Refresh templates
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <Link className="text-link" href="/templates" target="_blank" rel="noopener noreferrer">
                      Edit layouts and logo (new tab)
                    </Link>
                    <button
                      type="button"
                      className="link-button"
                      style={{ fontSize: '0.85rem', color: 'var(--muted, #666)' }}
                      onClick={async () => {
                        await refreshMasterData();
                        notify('Templates refreshed.');
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                )}
              </Field>
            )}

            <Field label="Document number">
              <input readOnly value={id} />
            </Field>

            <Field label="Date">
              <input type="date" max={TODAY} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>

            <Field label={quotation ? 'Valid until' : 'Due date'}>
              <input type="date" min={date} value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>

            {purchase ? (
              <Field label="Supplier invoice / reference">
                <input
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="e.g. CIT/26/8053 (optional for order/draft)"
                />
              </Field>
            ) : (
              <Field label="Invoice content">
                <input readOnly value="Products and services" />
                <span className="muted">Add any combination of catalogue products, printing services and custom charges.</span>
              </Field>
            )}

            <Field label="GST supply type">
              <select value={taxMode} onChange={(e) => {
                setTaxMode(e.target.value as typeof taxMode);
                const destination = shipSeparate ? shipTo.state : billTo.state;
                if (destination) setPlaceOfSupply(destination);
              }}>
                <option value="Intra-state">Within state · CGST + SGST</option>
                <option value="Inter-state">Interstate · IGST</option>
              </select>
            </Field>

            <Field label="Place of supply">
              <input
                value={placeOfSupply}
                onChange={(e) => setPlaceOfSupply(e.target.value)}
                placeholder="State / union territory"
              />
            </Field>

            <Field label="Price entry mode">
              <select
                value={inclusive ? 'inclusive' : 'exclusive'}
                onChange={(e) => setInclusive(e.target.value === 'inclusive')}
              >
                <option value="inclusive">GST inclusive · entered rate includes tax</option>
                <option value="exclusive">GST exclusive · add tax to entered rate</option>
              </select>
            </Field>

            {person && (
              <div className="full customer-preview">
                <strong>{person.name}</strong>
                <span>
                  {person.phone} · {person.email || 'No email'}
                </span>
                <p>{person.address}</p>
                <small>GSTIN: {person.gst || 'Not provided'}</small>
                {!purchase && (person as any).details?.creditLimit && (
                  <p>
                    Credit limit: {money(Number((person as any).details?.creditLimit))} · Review existing and new dues
                    before allowing credit.
                  </p>
                )}
                {!purchase && (
                  <p>
                    Existing outstanding:{' '}
                    {money(
                      state.bills
                        .filter((b) => b.customerId === customerId && b.kind !== 'Quotation')
                        .reduce((n, b) => n + balance(state, b), 0)
                    )}
                  </p>
                )}
              </div>
            )}
          </div>

          {!purchase && (
            <div className="form-body">
              <div className="form-grid">
                <div className="full">
                  <strong>Buyer (Bill to)</strong>
                  <p className="muted">These details are saved on this document only. Updating them does not change the customer profile.</p>
                </div>
                {Object.entries({
                  name: 'Bill-to name',
                  address: 'Billing address',
                  phone: 'Billing phone',
                  state: 'State / territory',
                  stateCode: 'State code',
                  postalCode: 'PIN code',
                }).map(([k, label]) => (
                  <Field key={k} label={`${label}${['name', 'address', 'state'].includes(k) ? ' *' : ''}`}>
                    <input
                      value={(billTo as any)[k] || ''}
                      onChange={(e) => {
                        const next = {...billTo, [k]: e.target.value};
                        setBillTo(next);
                        if (k === 'state' && !shipSeparate) setPlaceOfSupply(e.target.value);
                      }}
                    />
                  </Field>
                ))}
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={shipSeparate}
                  onChange={(e) => {
                    setShipSeparate(e.target.checked);
                    if (e.target.checked && !shipTo.name) {
                      setShipTo({
                        name: person?.name || '',
                        address: (person as any)?.details?.shippingAddress || person?.address || '',
                        phone: person?.phone || '',
                        state: (person as any)?.details?.state || 'Tamil Nadu',
                        postalCode: (person as any)?.details?.postalCode || '',
                      });
                      setPlaceOfSupply((person as any)?.details?.shippingState || (person as any)?.details?.state || billTo.state || '');
                    }
                  }}
                />
                Ship to a different address
              </label>
              {shipSeparate ? (
                <div className="form-grid">
                  {Object.entries({
                    name: 'Ship-to name',
                    address: 'Delivery address',
                    phone: 'Delivery phone',
                    state: 'State / territory',
                    postalCode: 'PIN code',
                  }).map(([k, label]) => (
                    <Field key={k} label={label}>
                      <input
                        value={(shipTo as any)[k]}
                        onChange={(e) => setShipTo({ ...shipTo, [k]: e.target.value })}
                      />
                    </Field>
                  ))}
                </div>
              ) : (
                <p>Ship to uses the selected customer’s billing details.</p>
              )}
            </div>
          )}
        </Card>

        <Card
          title="Invoice items"
          sub={
            inclusive
              ? 'Rates include GST. Discounts apply before tax; charges use their own editable GST rate.'
              : 'GST is added after discount. Changing the price mode reinterprets the entered rates.'
          }
          actions={<span className="muted">{lines.length} lines</span>}
        >
          {!purchase && (
            <div className="toolbar" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px', minWidth: '240px' }}>
                <SearchSelect
                  placeholder="Search and choose a product catalogue item…"
                  value={product}
                  options={(purchase && isLive ? productChoices : state.products).map((p: any) => ({
                    value: p.id,
                    label: p.name,
                    sublabel: `${p.category || 'Product'} · ${p.unit || 'Piece'} · ${money(purchase ? p.cost : p.price)}`,
                  }))}
                  onChange={(val) => setProduct(val)}
                  onClear={() => setProduct('')}
                />
              </div>
              <Btn secondary onClick={addProduct}>
                <Plus size={15} />
                Add product
              </Btn>
              <Btn secondary onClick={() => setNewProduct(true)}>
                Create product
              </Btn>
            </div>
          )}
          {purchase && (
            <p className="muted body-pad" style={{paddingTop: 0, paddingBottom: '0.5rem'}}>
              The product’s saved cost is only a starting value. Edit the rate on this purchase when the supplier price changes; the received lot keeps that exact historical cost while the product remains the same item.
            </p>
          )}

          {!purchase && (
            <div className="toolbar" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              <div style={{ flex: '1 1 320px', minWidth: '240px' }}>
                <SearchSelect
                  placeholder="Search and choose a service catalogue item…"
                  value={serviceId}
                  options={state.serviceCatalog
                    .filter((x) => x.active)
                    .map((x) => ({
                      value: x.id,
                      label: x.name,
                      sublabel: `${x.category || 'Service'} · ${money(x.rate)}`,
                    }))}
                  onChange={(val) => setServiceId(val)}
                  onClear={() => setServiceId('')}
                />
              </div>
              <Btn
                secondary
                onClick={() => {
                  const x = state.serviceCatalog.find((x) => x.id === serviceId);
                  if (x) {
                    setLines((ls) => [
                      ...ls,
                      {
                        ...blankLine(),
                        lineType: 'Service',
                        serviceId: x.id,
                        name: x.name,
                        details: x.description || '',
                        unit: x.unit || 'Job',
                        rate: inclusive ? x.rate : x.rate / (1 + x.tax / 100),
                        tax: x.tax,
                        hsn: x.sac,
                        warranty: x.warranty,
                        clientLineKey: uid('CLK'),
                      } as any,
                    ]);
                  }
                  setServiceId('');
                }}
              >
                <Plus size={15} /> Add service
              </Btn>
              <Link className="text-link" href="/service-catalog">
                Manage services
              </Link>
            </div>
          )}

          <div className="table-wrap">
            <table className="line-table">
              <thead>
                <tr>
                  <th>Item / HSN</th>
                  <th>Qty</th>
                  <th>Rate {inclusive ? 'incl. GST' : 'excl. GST'}</th>
                  <th>Discount</th>
                  <th>GST %</th>
                  <th>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={(l as any).clientLineKey || i}>
                    <td>
                      <input
                        aria-label={`Item ${i + 1} description`}
                        className="table-input wide-input"
                        value={l.name}
                        onChange={(e) => update(i, 'name', e.target.value)}
                      />
                      <textarea
                        aria-label={`Item ${i + 1} details`}
                        className="table-input wide-input"
                        value={l.details || ''}
                        placeholder="Product or service description"
                        onChange={(e) => update(i, 'details', e.target.value)}
                      />
                      <div className="line-meta">
                        <input
                          aria-label={`Item ${i + 1} HSN`}
                          placeholder="HSN / SAC"
                          value={l.hsn}
                          onChange={(e) => update(i, 'hsn', e.target.value)}
                        />

                        {l.lineType === 'Charge' && <Badge>Non-stock charge</Badge>}
                      </div>
                      {l.lineType === 'Service' && (
                        <details className="line-specifications">
                          <summary>Print specifications</summary>
                          <div className="line-spec-grid">
                            {[
                              ['size','Size'],['material','Paper / material'],['gsm','GSM'],['colour','Colour'],
                              ['sides','Printing sides'],['finishing','Finishing'],['deliveryDate','Delivery date'],['notes','Specification notes'],
                            ].map(([key,label]) => <input key={key} type={key==='deliveryDate'?'date':'text'} aria-label={`${label} for item ${i+1}`} placeholder={label} value={(l.printSpecifications as any)?.[key] || ''} onChange={(e)=>updatePrintSpecification(i,key,e.target.value)} />)}
                          </div>
                        </details>
                      )}
                    </td>
                    <td>
                      <input
                        aria-label={`Item ${i + 1} quantity`}
                        className="table-input"
                        type="number"
                        min={isReceiptMode ? 0 : 1}
                        max={isReceiptMode ? Math.max(0, (l as any).quantityOrdered - (l as any).quantityReceived - (l as any).quantityCancelled) : undefined}
                        disabled={(isPosted && !isReceiptMode) || l.lineType === 'Charge'}
                        value={l.qty}
                        onChange={(e) => update(i, 'qty', +e.target.value)}
                      />
                      <select aria-label={`Item ${i + 1} unit`} value={l.unit || (l.lineType === 'Service' ? 'Job' : 'Piece')} onChange={(e)=>update(i,'unit',e.target.value)}>
                        {['Piece','Sheet','Page','Set','Book','Box','Square foot','Roll','Pack','Job'].map(unit=><option key={unit}>{unit}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`Item ${i + 1} rate`}
                        className="table-input"
                        type="number"
                        min="0"
                        step="0.01"
                        disabled={isPosted}
                        value={l.rate}
                        onChange={(e) => update(i, 'rate', +e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Item ${i + 1} discount`}
                        className="table-input"
                        type="number"
                        min="0"
                        max={l.discountType === 'Amount' ? l.qty * l.rate : 100}
                        disabled={isPosted}
                        value={l.discount}
                        onChange={(e) => update(i, 'discount', +e.target.value)}
                      />
                      <select
                        aria-label={`Item ${i + 1} discount type`}
                        value={l.discountType || 'Percentage'}
                        disabled={isPosted}
                        onChange={(e) => {
                          update(i, 'discountType', e.target.value);
                          update(i, 'discount', 0);
                        }}
                      >
                        <option value="Percentage">%</option>
                        <option value="Amount">₹ per line</option>
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Item ${i + 1} tax treatment`}
                        className="table-input"
                        disabled={isPosted}
                        style={{ marginBottom: 4 }}
                        value={l.taxTreatment || 'Taxable'}
                        onChange={(e) => {
                          const val = e.target.value as 'Taxable' | 'Exempt' | 'NonGST';
                          update(i, 'taxTreatment', val);
                          if (val === 'Exempt' || val === 'NonGST') {
                            update(i, 'tax', 0);
                          }
                        }}
                      >
                        <option value="Taxable">Taxable</option>
                        <option value="Exempt">Exempt</option>
                        <option value="NonGST">Non-GST</option>
                      </select>
                      <select
                        aria-label={`Item ${i + 1} GST`}
                        className="table-input"
                        disabled={isPosted || l.taxTreatment === 'Exempt' || l.taxTreatment === 'NonGST'}
                        value={l.taxTreatment === 'Exempt' || l.taxTreatment === 'NonGST' ? 0 : l.tax}
                        onChange={(e) => update(i, 'tax', +e.target.value)}
                      >
                        {[0, 5, 12, 18, 28].map((v) => (
                          <option key={v} value={v}>
                            {v}%
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="amount">
                      {money(lineTotal(l, inclusive).total)}
                      <small>Base {money(lineTotal(l, inclusive).base)}</small>
                      <small>GST {money(lineTotal(l, inclusive).tax)}</small>
                    </td>
                    <td>
                      <div className="action-cell">
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={i === 0}
                          aria-label={`Move item ${i + 1} up`}
                          onClick={() => reorder(i, -1)}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={i === lines.length - 1}
                          aria-label={`Move item ${i + 1} down`}
                          onClick={() => reorder(i, 1)}
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Remove item ${i + 1}`}
                          onClick={() => setLines((ls) => ls.filter((_, n) => i !== n))}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!lines.length && (
            <Empty
              title="Add your first item"
              text="Choose a product or service above to start this invoice."
            />
          )}

          <div className="toolbar">
            <Btn
              secondary
              onClick={() =>
                setLines((ls) => [
                  ...ls,
                  {
                    ...blankLine(),
                    lineType: 'Charge',
                    name: 'Shipping charge',
                    qty: 1,
                    rate: 0,
                    tax: 18,
                    warranty: 0,
                    clientLineKey: uid('CLK'),
                  } as any,
                ])
              }
            >
              Add shipping charge
            </Btn>
            <Btn
              secondary
              onClick={() =>
                setLines((ls) => [
                  ...ls,
                  {
                    ...blankLine(),
                    lineType: 'Charge',
                    name: 'Additional charge',
                    qty: 1,
                    rate: 0,
                    tax: 18,
                    warranty: 0,
                    clientLineKey: uid('CLK'),
                  } as any,
                ])
              }
            >
              Add other charge
            </Btn>
            {!purchase && (
              <Btn secondary onClick={() => setLines((ls) => [...ls, { ...blankLine(), lineType: 'Service', unit: 'Job' }])}>
                <Plus size={14} />
                Add custom service line
              </Btn>
            )}
            <span className="muted">A custom charge is financial only. Select a catalogue product or service above for standard line items.</span>
          </div>
        </Card>

        {!quotation && !purchase && (
          <Card
            title="Payment received"
            sub="Leave empty for credit. Add one or more payments for a full, partial or split payment."
          >
            <div className="form-body stack">
              {payRows.map((p, i) => (
                <div className="payment-entry-row" key={i}>
                  <Field label="Method">
                    <select
                      value={p.method}
                      onChange={(e) =>
                        setPayRows((rows) =>
                          rows.map((r, n) =>
                            n === i
                              ? {
                                ...r,
                                method: e.target.value,
                                account: e.target.value === 'Cash' ? 'Cash' : 'Bank account',
                              }
                              : r
                          )
                        )
                      }
                    >
                      <option>Cash</option>
                      <option>GPay / UPI</option>
                      <option>Bank transfer</option>
                      <option>Card</option>
                    </select>
                  </Field>
                  <Field label="Account">
                    <select
                      value={p.account}
                      onChange={(e) =>
                        setPayRows((rows) => rows.map((r, n) => (n === i ? { ...r, account: e.target.value } : r)))
                      }
                    >
                      {(p.method === 'Cash' ? ['Cash'] : ['Bank account']).map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Amount">
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={p.amount}
                      onChange={(e) =>
                        setPayRows((rows) => rows.map((r, n) => (n === i ? { ...r, amount: e.target.value } : r)))
                      }
                    />
                  </Field>
                  <Btn secondary onClick={() => setPayRows((rows) => rows.filter((_, n) => n !== i))}>
                    Remove
                  </Btn>
                </div>
              ))}
              <div className="actions">
                <Btn secondary onClick={() => setPayRows((rows) => [...rows, { account: 'Cash', method: 'Cash', amount: '' }])}>
                  Add payment
                </Btn>
                <Btn
                  secondary
                  onClick={() =>
                    setPayRows([
                      {
                        account: 'Cash',
                        method: 'Cash',
                        amount: String(Math.max(0, roundedTotal(bill) - (existing ? paid(state, id) : 0))),
                      },
                    ])
                  }
                >
                  Pay remaining in cash
                </Btn>
              </div>
              <div className="summary-row">
                <span>Remaining outstanding</span>
                <strong
                  className={
                    sum.total -
                      payRows.reduce((n, p) => n + (+p.amount || 0), 0) -
                      (existing ? paid(state, id) : 0) <
                      0
                      ? 'error'
                      : ''
                  }
                >
                  {money(
                    sum.total -
                    payRows.reduce((n, p) => n + (+p.amount || 0), 0) -
                    (existing ? paid(state, id) : 0)
                  )}
                </strong>
              </div>
            </div>
          </Card>
        )}

        <div className="detail-grid">
          <Card title="Notes and terms">
            <div className="body-pad">
              {purchase && isLive && (
                <Field label="Supplier bill / purchase attachment">
                  <input
                    type="file"
                    accept="application/pdf,image/png,image/jpeg"
                    disabled={uploadingAttachment}
                    onChange={(e) => void uploadPurchaseAttachment(e.target.files?.[0])}
                  />
                  <small>
                    {uploadingAttachment
                      ? 'Uploading…'
                      : attachmentFileId
                        ? `${attachmentName || 'Attachment'} is linked to this purchase.`
                        : 'PDF, JPG or PNG up to 5 MB. Files are private to this company.'}
                  </small>
                  {attachmentFileId && (
                    <Btn secondary onClick={() => { setAttachmentFileId(''); setAttachmentName(''); }}>
                      Remove attachment
                    </Btn>
                  )}
                </Field>
              )}
              <details className="optional-fields">
                <summary>Order and delivery references</summary>
                <Field label="Buyer order number">
                  <input value={orderRef} onChange={(e) => setOrderRef(e.target.value)} />
                </Field>
                <Field label="Delivery note">
                  <input value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />
                </Field>
                <Field label="Dispatched through">
                  <input value={dispatch} onChange={(e) => setDispatch(e.target.value)} />
                </Field>
              </details>
              <Field label="Printed notes">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Warranty terms, payment terms, delivery instructions…"
                />
              </Field>
            </div>
          </Card>

          <div className="summary-box">
            <div className="summary-row">
              <span>Taxable value</span>
              <b>{money(sum.base)}</b>
            </div>
            {taxMode === 'Inter-state' ? (
              <div className="summary-row">
                <span>IGST</span>
                <b>{money(sum.igst)}</b>
              </div>
            ) : (
              <>
                <div className="summary-row">
                  <span>CGST</span>
                  <b>{money(sum.cgst)}</b>
                </div>
                <div className="summary-row">
                  <span>SGST</span>
                  <b>{money(sum.sgst)}</b>
                </div>
              </>
            )}
            <div className="summary-row total">
              <span>Total</span>
              <b>{money(sum.total)}</b>
            </div>
            <small>Discounts are applied to each item before calculating tax.</small>
          </div>
        </div>

        <div className="form-actions">
          <Link className="btn secondary" href="/sales">
            Cancel
          </Link>
          {purchase ? (
            isReceiptMode ? (
              <Btn disabled={busy} onClick={() => handlePurchaseAction('receive')}>
                Confirm stock receipt
              </Btn>
            ) : (
              <>
                <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('draft')}>
                  Save draft
                </Btn>
                <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('confirm')}>
                  Confirm order
                </Btn>
                <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('post')}>
                  Post supplier bill
                </Btn>
                <Btn secondary disabled={busy} onClick={() => handlePurchaseAction('receive')}>
                  Record + Receive
                </Btn>
                <Btn disabled={busy} onClick={() => handlePurchaseAction('receive_pay')}>
                  Record + Receive + Pay
                </Btn>
              </>
            )
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {quotation ? (
                <Btn disabled={busy} onClick={() => handleSalesAction('save_draft')}>
                  Save quotation
                </Btn>
              ) : (
                <>
                  <Btn secondary disabled={busy} onClick={() => handleSalesAction('save_draft')}>
                    Save draft
                  </Btn>
                  <Btn disabled={busy} onClick={() => handleSalesAction('issue')}>
                    Issue invoice
                  </Btn>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {postModalOpen && (
        <Modal title="Post supplier bill" onClose={() => setPostModalOpen(false)}>
          <form onSubmit={submitPostModal}>
            <div className="form-body form-grid">
              <Field label="Supplier invoice number *">
                <input
                  required
                  maxLength={100}
                  value={postInvoiceNumber}
                  onChange={(e) => setPostInvoiceNumber(e.target.value)}
                  placeholder="e.g. INV-9082"
                />
              </Field>
              <Field label="Supplier invoice date *">
                <input
                  required
                  type="date"
                  max={TODAY}
                  value={postInvoiceDate}
                  onChange={(e) => setPostInvoiceDate(e.target.value)}
                />
              </Field>
              <p className="notice full">
                Posting creates the official supplier payable. Payment can be recorded now or later.
              </p>
            </div>
            <div className="form-actions">
              <Btn secondary onClick={() => setPostModalOpen(false)}>
                Cancel
              </Btn>
              <Btn type="submit" disabled={busy}>
                {busy ? 'Posting…' : 'Post bill'}
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {payModalOpen && (
        <Modal title="Record, Receive & Pay supplier" onClose={() => setPayModalOpen(false)}>
          <form onSubmit={submitReceiveAndPay}>
            <div className="form-body form-grid">
              <Field label="Supplier invoice number *">
                <input
                  required
                  value={postInvoiceNumber}
                  onChange={(e) => setPostInvoiceNumber(e.target.value)}
                  placeholder="e.g. INV-9082"
                />
              </Field>
              <Field label="Supplier invoice date *">
                <input required type="date" max={TODAY} value={postInvoiceDate} onChange={(e) => setPostInvoiceDate(e.target.value)} />
              </Field>
              <Field label="Payment account">
                <select value={payAccount} onChange={(e) => setPayAccount(e.target.value)}>
                  <option>Cash</option>
                  <option>Bank account</option>
                </select>
              </Field>
              <div className="full notice">
                Total to pay: <strong>{money(sum.total)}</strong>. All stock will be marked as received and payment
                recorded against this purchase.
              </div>
            </div>
            <div className="form-actions">
              <Btn secondary onClick={() => setPayModalOpen(false)}>
                Cancel
              </Btn>
              <Btn type="submit" disabled={busy}>
                {busy ? 'Processing…' : 'Confirm Receive & Pay'}
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {conflictModalOpen && (
        <Modal title="Version Conflict" onClose={() => setConflictModalOpen(false)}>
          <div className="form-body">
            <div className="notice error">
              <AlertCircle size={20} />
              <p>{conflictMessage || 'This purchase order has been updated by another user or session.'}</p>
            </div>
            <p>Please reload the latest purchase details before making modifications.</p>
          </div>
          <div className="form-actions">
            <Btn secondary onClick={() => setConflictModalOpen(false)}>
              Cancel
            </Btn>
            <Btn
              onClick={async () => {
                await reloadLatestDraft();
                setConflictModalOpen(false);
              }}
            >
              Reload latest
            </Btn>
          </div>
        </Modal>
      )}

      {newProduct && <ProductForm onClose={() => setNewProduct(false)} />}
      {newPerson && <PersonForm supplier={purchase} onClose={() => setNewPerson(false)} />}

      {/* Serial modal removed - products are catalogue records only */}

      {review && !purchase && (
        <PrintDialog
          bills={[{ ...bill, previewPaid: payRows.reduce((n, p) => n + (+p.amount || 0), 0) }]}
          onClose={() => setReview(false)}
        />
      )}

      {review && purchase && (
        <Modal title="Document preview" wide onClose={() => setReview(false)}>
          <InvoicePaper bill={bill} supplier={person as any} />
          <div className="form-actions">
            <Btn secondary onClick={() => window.print()}>
              <Printer size={16} />
              Print / save PDF
            </Btn>
            <Btn onClick={() => setReview(false)}>Continue editing</Btn>
          </div>
        </Modal>
      )}



      {issueModalOpen && issueTargetDraft && (
        <IssueInvoiceModal
          isOpen={issueModalOpen}
          onClose={() => setIssueModalOpen(false)}
          draft={issueTargetDraft}
          initialPayments={payRows}
          onIssued={(inv) => {
            const invoiceId = inv?._id || inv?.id || issueTargetDraft.id;
            router.push('/sales/' + invoiceId);
          }}
        />
      )}
    </>
  );
}


export default function Documents({
  quotation = false,
  purchase = false,
  id,
}: {
  quotation?: boolean;
  purchase?: boolean;
  id?: string;
}) {
  const {
    state,
    setState,
    notify,
    isLive,
    fetchPurchaseDetailApi,
    fetchPurchaseReceiptsApi,
    fetchPurchaseAllocationsApi,
    fetchPurchaseReturnsApi,
    fetchPurchaseCreditNotesApi,
    reversePurchaseReceiptApi,
    reverseSupplierReturnApi,
    reverseSupplierPaymentApi,
    reverseSupplierAllocationApi,
    reverseSupplierCreditNoteApi,
    fetchPurchasesPage,
    fetchQuotationsPage,
    fetchQuotationDetailApi,
    shareQuotationApi,
    convertQuotationApi,
    cancelQuotationApi,
    reopenQuotationApi,
    fetchInvoicesPage,
    fetchInvoiceDetailApi,
    cancelInvoiceDraftApi,
    issueInvoiceApi,
    recordCustomerReceiptApi,
  } = useStore();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [q, setQ] = useState(() => searchParams?.get('search') || searchParams?.get('q') || '');
  const deferredQ = useDeferredValue(q);
  const [status, setStatus] = useState(() => searchParams?.get('status') || 'All');
  const [docStatusFilter, setDocStatusFilter] = useState(() => searchParams?.get('docStatus') || 'All');
  const [billStatusFilter, setBillStatusFilter] = useState(() => searchParams?.get('billStatus') || 'All');
  const [receiptStatusFilter, setReceiptStatusFilter] = useState(() => searchParams?.get('receiptStatus') || 'All');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState(() => searchParams?.get('paymentStatus') || 'All');
  const [payment, setPayment] = useState(false);
  const [date, setDate] = useState(() => searchParams?.get('date') || '');
  const [dateFrom, setDateFrom] = useState(() => searchParams?.get('dateFrom') || '');
  const [dateTo, setDateTo] = useState(() => searchParams?.get('dateTo') || '');
  const [cancel, setCancel] = useState(false);
  const [print, setPrint] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState(() => searchParams?.get('category') || 'All categories');
  const [purchasePage, setPurchasePage] = useState(() => Math.max(1, parseInt(searchParams?.get('page') || '1', 10)));
  const [quotationPage, setQuotationPage] = useState(1);
  const [quotationPageData, setQuotationPageData] = useState<{ records: Bill[]; total: number; totalPages: number } | null>(null);
  const [quotationListLoading, setQuotationListLoading] = useState(false);

  const [invoicePage, setInvoicePage] = useState(() => Math.max(1, parseInt(searchParams?.get('page') || '1', 10)));
  const [invoicePageData, setInvoicePageData] = useState<{ records: Bill[]; total: number; totalPages: number } | null>(null);
  const [invoiceListLoading, setInvoiceListLoading] = useState(false);
  const [filteredBatchBills, setFilteredBatchBills] = useState<Bill[]>([]);
  const [filteredBatchLoading, setFilteredBatchLoading] = useState(false);

  const [salesSummary, setSalesSummary] = useState<any>(null);
  const salesCategoryValue = categoryFilter === 'New goods' ? 'NewGoods' : categoryFilter === 'Used goods' ? 'UsedGoods' : categoryFilter === 'Service' ? 'Service' : undefined;

  // Live Modals for Quotation & Invoice
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [issueTargetDraft, setIssueTargetDraft] = useState<{ id: string; version: number; totalPaise: number; customerId: string } | null>(null);
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [receiptTargetInvoice, setReceiptTargetInvoice] = useState<{ id: string; customerId: string; dueAmount: number } | null>(null);
  const [quoteCancelOpen, setQuoteCancelOpen] = useState(false);
  const [quoteReopenOpen, setQuoteReopenOpen] = useState(false);
  const [deliveryChallanOpen, setDeliveryChallanOpen] = useState(false);
  const [invCancelOpen, setInvCancelOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  // Sync active purchase list filters to URL
  useEffect(() => {
    if (!purchase || id) return;
    const url = new URL(window.location.href);
    if (q.trim()) url.searchParams.set('search', q.trim()); else url.searchParams.delete('search');
    if (docStatusFilter !== 'All') url.searchParams.set('docStatus', docStatusFilter); else url.searchParams.delete('docStatus');
    if (billStatusFilter !== 'All') url.searchParams.set('billStatus', billStatusFilter); else url.searchParams.delete('billStatus');
    if (receiptStatusFilter !== 'All') url.searchParams.set('receiptStatus', receiptStatusFilter); else url.searchParams.delete('receiptStatus');
    if (paymentStatusFilter !== 'All') url.searchParams.set('paymentStatus', paymentStatusFilter); else url.searchParams.delete('paymentStatus');
    if (date) url.searchParams.set('date', date); else url.searchParams.delete('date');
    if (purchasePage > 1) url.searchParams.set('page', String(purchasePage)); else url.searchParams.delete('page');
    window.history.replaceState(null, '', url.pathname + url.search);
  }, [purchase, id, q, docStatusFilter, billStatusFilter, receiptStatusFilter, paymentStatusFilter, date, purchasePage]);

  useEffect(() => {
    if (purchase || quotation || id) return;
    const url = new URL(window.location.href);
    if (q.trim()) url.searchParams.set('q', q.trim()); else url.searchParams.delete('q');
    if (status !== 'All') url.searchParams.set('status', status); else url.searchParams.delete('status');
    if (categoryFilter !== 'All categories') url.searchParams.set('category', categoryFilter); else url.searchParams.delete('category');
    if (dateFrom) url.searchParams.set('dateFrom', dateFrom); else url.searchParams.delete('dateFrom');
    if (dateTo) url.searchParams.set('dateTo', dateTo); else url.searchParams.delete('dateTo');
    if (invoicePage > 1) url.searchParams.set('page', String(invoicePage)); else url.searchParams.delete('page');
    window.history.replaceState(null, '', url.pathname + url.search);
  }, [purchase, quotation, id, q, status, categoryFilter, dateFrom, dateTo, invoicePage]);

  // Detail view state
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailRequestRef = useRef(0);
  const [quotationSharing, setQuotationSharing] = useState(false);
  const quotationShareAttempt = useRef<{fingerprint: string; key: string} | null>(null);
  const [detailTab, setDetailTab] = useState<'Overview' | 'Receipts' | 'Payments' | 'Returns' | 'Credit notes'>('Overview');
  const [reversalModal, setReversalModal] = useState<{
    open: boolean;
    type: 'receipt' | 'return' | 'payment' | 'allocation';
    id: string;
    title: string;
  }>({ open: false, type: 'receipt', id: '', title: '' });
  const [reversalReason, setReversalReason] = useState('');
  const [reversalBusy, setReversalBusy] = useState(false);

  // Dedicated paginated tab state for purchase detail
  const [rcptList, setRcptList] = useState<any[]>([]);
  const [rcptPage, setRcptPage] = useState(1);
  const [rcptTotalPages, setRcptTotalPages] = useState(1);
  const [rcptTotal, setRcptTotal] = useState(0);
  const [rcptLoading, setRcptLoading] = useState(false);
  const [rcptError, setRcptError] = useState('');

  const [allocList, setAllocList] = useState<any[]>([]);
  const [allocPage, setAllocPage] = useState(1);
  const [allocTotalPages, setAllocTotalPages] = useState(1);
  const [allocTotal, setAllocTotal] = useState(0);
  const [allocLoading, setAllocLoading] = useState(false);
  const [allocError, setAllocError] = useState('');

  const [retList, setRetList] = useState<any[]>([]);
  const [retPage, setRetPage] = useState(1);
  const [retTotalPages, setRetTotalPages] = useState(1);
  const [retTotal, setRetTotal] = useState(0);
  const [retLoading, setRetLoading] = useState(false);
  const [retError, setRetError] = useState('');

  const [cnList, setCnList] = useState<any[]>([]);
  const [cnPage, setCnPage] = useState(1);
  const [cnTotalPages, setCnTotalPages] = useState(1);
  const [cnTotal, setCnTotal] = useState(0);
  const [cnLoading, setCnLoading] = useState(false);
  const [cnError, setCnError] = useState('');

  const loadReceipts = () => {
    if (!id || !purchase || !isLive) return;
    setRcptLoading(true);
    setRcptError('');
    fetchPurchaseReceiptsApi(id, { page: rcptPage, limit: 10 })
      .then((res: any) => {
        setRcptList(res.receipts || res.records || []);
        setRcptTotalPages(res.totalPages || 1);
        setRcptTotal(res.total || 0);
      })
      .catch((err: any) => setRcptError(err.message || 'Failed to load stock receipts.'))
      .finally(() => setRcptLoading(false));
  };

  const loadAllocations = () => {
    if (!id || !purchase || !isLive) return;
    setAllocLoading(true);
    setAllocError('');
    fetchPurchaseAllocationsApi(id, { page: allocPage, limit: 10 })
      .then((res: any) => {
        setAllocList(res.allocations || res.records || []);
        setAllocTotalPages(res.totalPages || 1);
        setAllocTotal(res.total || 0);
      })
      .catch((err: any) => setAllocError(err.message || 'Failed to load payment allocations.'))
      .finally(() => setAllocLoading(false));
  };

  const loadReturns = () => {
    if (!id || !purchase || !isLive) return;
    setRetLoading(true);
    setRetError('');
    fetchPurchaseReturnsApi(id, { page: retPage, limit: 10 })
      .then((res: any) => {
        setRetList(res.returns || res.records || []);
        setRetTotalPages(res.totalPages || 1);
        setRetTotal(res.total || 0);
      })
      .catch((err: any) => setRetError(err.message || 'Failed to load returns.'))
      .finally(() => setRetLoading(false));
  };

  const loadCreditNotes = () => {
    if (!id || !purchase || !isLive) return;
    setCnLoading(true);
    setCnError('');
    fetchPurchaseCreditNotesApi(id, { page: cnPage, limit: 10 })
      .then((res: any) => {
        setCnList(res.creditNotes || res.records || []);
        setCnTotalPages(res.totalPages || 1);
        setCnTotal(res.total || 0);
      })
      .catch((err: any) => setCnError(err.message || 'Failed to load credit notes.'))
      .finally(() => setCnLoading(false));
  };

  useEffect(() => {
    if (purchase && id && isLive) {
      if (detailTab === 'Receipts') loadReceipts();
      else if (detailTab === 'Payments') loadAllocations();
      else if (detailTab === 'Returns') loadReturns();
      else if (detailTab === 'Credit notes') loadCreditNotes();
    }
  }, [purchase, id, isLive, detailTab]);

  useEffect(() => {
    if (purchase && id && isLive && detailTab === 'Receipts') loadReceipts();
  }, [rcptPage]);

  useEffect(() => {
    if (purchase && id && isLive && detailTab === 'Payments') loadAllocations();
  }, [allocPage]);

  useEffect(() => {
    if (purchase && id && isLive && detailTab === 'Returns') loadReturns();
  }, [retPage]);

  useEffect(() => {
    if (purchase && id && isLive && detailTab === 'Credit notes') loadCreditNotes();
  }, [cnPage]);

  // Summary counters
  const [summary, setSummary] = useState<any>(null);
  const [summaryError, setSummaryError] = useState('');
  const [summaryReload, setSummaryReload] = useState(0);
  const [purchasePageData, setPurchasePageData] = useState<{ records: Purchase[]; total: number; totalPages: number } | null>(null);
  const [purchaseListLoading, setPurchaseListLoading] = useState(false);

  const record = purchase
    ? (detailData?.purchase ? mapPurchaseFromApi(detailData.purchase) : state.purchases.find((b) => b.id === id))
    : quotation
      ? (detailData?.quotation ? detailData.quotation : state.bills.find((b) => b.id === id && b.kind === 'Quotation'))
      : (detailData?.invoice ? detailData.invoice : state.bills.find((b) => b.id === id && b.kind !== 'Quotation'));

  const refreshDetail = () => {
    if (id && isLive) {
      const requestId = ++detailRequestRef.current;
      setDetailLoading(true);
      setDetailError('');
      setDetailData(null);
      if (purchase) {
        fetchPurchaseDetailApi(id).then((res) => {
          if (requestId !== detailRequestRef.current) return;
          if (res?.purchase) {
            setDetailData(res);
            if (res.receipts?.length && !rcptList.length) setRcptList(res.receipts);
            if (res.allocations?.length && !allocList.length) setAllocList(res.allocations);
            if (res.returns?.length && !retList.length) setRetList(res.returns);
            if (res.creditNotes?.length && !cnList.length) setCnList(res.creditNotes);
          }
        }).catch((error) => {
          if (requestId === detailRequestRef.current) setDetailError(error instanceof Error ? error.message : 'Could not load purchase.');
        }).finally(() => { if (requestId === detailRequestRef.current) setDetailLoading(false); });
      } else if (quotation) {
        fetchQuotationDetailApi(id).then((res) => {
          if (requestId !== detailRequestRef.current) return;
          if (res?.quotation) {
            setDetailData({ quotation: mapQuotationFromApi(res.quotation), raw: res.quotation });
          }
        }).catch((error) => {
          if (requestId === detailRequestRef.current) setDetailError(error instanceof Error ? error.message : 'Could not load quotation.');
        }).finally(() => { if (requestId === detailRequestRef.current) setDetailLoading(false); });
      } else {
        fetchInvoiceDetailApi(id).then((res) => {
          if (requestId !== detailRequestRef.current) return;
          if (res?.invoice) {
            setDetailData({ invoice: mapInvoiceFromApi(res.invoice), raw: res.invoice });
          }
        }).catch((error) => {
          if (requestId === detailRequestRef.current) setDetailError(error instanceof Error ? error.message : 'Could not load invoice.');
        }).finally(() => { if (requestId === detailRequestRef.current) setDetailLoading(false); });
      }
    }
  };

  useEffect(() => {
    refreshDetail();
    return () => { detailRequestRef.current += 1; };
  }, [id, purchase, quotation, isLive]);

  useEffect(() => {
    if (purchase && !id && isLive) {
      setSummaryError('');
      fetch('/api/purchases/summary')
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Could not load purchase summary.');
          return data;
        })
        .then((data) => {
          setSummary(data.summary || data);
        })
        .catch((error) => setSummaryError(error instanceof Error ? error.message : 'Could not load purchase summary.'));
    }
  }, [purchase, id, isLive, summaryReload]);

  useEffect(() => {
    if (!purchase && !id && isLive) {
      const query = new URLSearchParams();
      if (!quotation) {
        if (deferredQ.trim()) query.set('search', deferredQ.trim());
        if (status !== 'All') query.set('status', status);
        if (status === 'Unpaid') query.set('hasDue', 'true');
        if (salesCategoryValue) query.set('businessCategory', salesCategoryValue);
        if (dateFrom) query.set('dateFrom', dateFrom);
        if (dateTo) query.set('dateTo', dateTo);
      }
      fetch(`/api/sales/summary?${query.toString()}`)
        .then((r) => r.json())
        .then((data) => {
          setSalesSummary(data.summary || data);
        })
        .catch(() => { });
    }
  }, [purchase, quotation, id, isLive, deferredQ, status, salesCategoryValue, dateFrom, dateTo]);

  useEffect(() => {
    if (!purchase || id || !isLive) return;
    setPurchaseListLoading(true);
    fetchPurchasesPage({
      page: purchasePage,
      limit: 20,
      search: q.trim() || undefined,
      documentStatus: docStatusFilter === 'All' ? undefined : docStatusFilter,
      billStatus: billStatusFilter === 'All' ? undefined : billStatusFilter,
      receiptStatus: receiptStatusFilter === 'All' ? undefined : receiptStatusFilter,
      paymentStatus: paymentStatusFilter === 'All' ? undefined : paymentStatusFilter,
      dateFrom: date || undefined,
      dateTo: date || undefined,
    }).then(setPurchasePageData).catch(() => notify('Could not load purchases.')).finally(() => setPurchaseListLoading(false));
  }, [purchase, id, isLive, purchasePage, q, docStatusFilter, billStatusFilter, receiptStatusFilter, paymentStatusFilter, date, fetchPurchasesPage, notify]);

  useEffect(() => { setPurchasePage(1); }, [q, docStatusFilter, billStatusFilter, receiptStatusFilter, paymentStatusFilter, date]);

  useEffect(() => {
    if (!quotation || purchase || id || !isLive) return;
    setQuotationListLoading(true);
    fetchQuotationsPage({
      page: quotationPage,
      limit: 20,
      search: q.trim() || undefined,
      status: status === 'All' ? undefined : status,
      dateFrom: date || undefined,
      dateTo: date || undefined,
    }).then(setQuotationPageData).catch(() => notify('Could not load quotations.')).finally(() => setQuotationListLoading(false));
  }, [quotation, purchase, id, isLive, quotationPage, q, status, date, fetchQuotationsPage, notify]);

  useEffect(() => { setQuotationPage(1); }, [q, status, date]);

  useEffect(() => {
    if (quotation || purchase || id || !isLive) return;
    setInvoiceListLoading(true);
    fetchInvoicesPage({
      page: invoicePage,
      limit: 20,
      search: deferredQ.trim() || undefined,
      status: status === 'All' ? undefined : status,
      hasDue: status === 'Unpaid' ? true : undefined,
      businessCategory: salesCategoryValue,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }).then(setInvoicePageData).catch(() => notify('Could not load invoices.')).finally(() => setInvoiceListLoading(false));
  }, [quotation, purchase, id, isLive, invoicePage, deferredQ, status, categoryFilter, dateFrom, dateTo, fetchInvoicesPage, notify]);

  useEffect(() => { setInvoicePage(1); }, [deferredQ, status, categoryFilter, dateFrom, dateTo]);

  const list = (
    purchase
      ? (isLive ? (purchasePageData?.records || []) : state.purchases)
      : quotation
        ? (isLive ? (quotationPageData?.records || []) : state.bills.filter((b) => b.kind === 'Quotation'))
        : (isLive ? (invoicePageData?.records || []) : state.bills.filter((b) => b.kind !== 'Quotation'))
  ).filter((b) => {
    if (isLive) return true;
    const p = purchase
      ? state.suppliers.find((c) => c.id === (b as Purchase).supplierId)
      : state.customers.find((c) => c.id === (b as Bill).customerId);
    const matchSearch = (b.id + (p?.name || '')).toLowerCase().includes(q.toLowerCase());
    const matchDate = purchase || quotation
      ? (!date || b.date === date)
      : (!dateFrom || b.date >= dateFrom) && (!dateTo || b.date <= dateTo);
    const matchCat = purchase || quotation || categoryFilter === 'All categories' || (b as Bill).category === categoryFilter;

    if (purchase) {
      const pur = b as Purchase;
      const matchDoc = docStatusFilter === 'All' || pur.documentStatus === docStatusFilter;
      const matchBill = billStatusFilter === 'All' || pur.billStatus === billStatusFilter;
      const matchRec = receiptStatusFilter === 'All' || pur.receiptStatus === receiptStatusFilter;
      const matchPay = paymentStatusFilter === 'All' || pur.paymentStatus === paymentStatusFilter;
      return matchSearch && matchDate && matchDoc && matchBill && matchRec && matchPay;
    }

    const matchStatus =
      status === 'All' ||
      b.status === status ||
      (status === 'Unpaid' && balance(state, b) > 0) ||
      (status === 'Paid' && balance(state, b) === 0);

    return matchSearch && matchDate && matchCat && matchStatus;
  });

  const path = '/sales';
  const purchaseExportUrl = (format: string) => {
    const query = new URLSearchParams({ format });
    if (q.trim()) query.set('search', q.trim());
    if (docStatusFilter !== 'All') query.set('documentStatus', docStatusFilter);
    if (billStatusFilter !== 'All') query.set('billStatus', billStatusFilter);
    if (receiptStatusFilter !== 'All') query.set('receiptStatus', receiptStatusFilter);
    if (paymentStatusFilter !== 'All') query.set('paymentStatus', paymentStatusFilter);
    if (date) { query.set('dateFrom', date); query.set('dateTo', date); }
    return `/api/purchases/export?${query.toString()}`;
  };

  const quotationExportUrl = (format: string) => {
    const query = new URLSearchParams({ format });
    if (q.trim()) query.set('search', q.trim());
    if (status !== 'All') query.set('status', status);
    if (date) { query.set('dateFrom', date); query.set('dateTo', date); }
    return `/api/sales/quotations/export?${query.toString()}`;
  };

  const invoiceExportUrl = (format: string) => {
    const query = new URLSearchParams({ format });
    if (q.trim()) query.set('search', q.trim());
    if (status !== 'All') query.set('status', status);
    if (status === 'Unpaid') query.set('hasDue', 'true');
    if (salesCategoryValue) query.set('businessCategory', salesCategoryValue);
    if (dateFrom) query.set('dateFrom', dateFrom);
    if (dateTo) query.set('dateTo', dateTo);
    return `/api/sales/invoices/export?${query.toString()}`;
  };

  if (id && isLive && (detailLoading || (!detailData && !detailError))) {
    const documentName = purchase ? 'purchase' : quotation ? 'quotation' : 'invoice';
    return <Empty title={`Loading ${documentName}…`} text={`Loading the live ${documentName} details. A newly created document may take a moment to appear.`} />;
  }
  if (id && isLive && detailError) {
    const missing = /not found/i.test(detailError);
    return (
      <Empty
        title={missing ? 'Document not found' : 'Could not load document'}
        text={missing ? 'This document does not exist or is unavailable to this company.' : detailError}
        action={<div className="form-actions"><Btn secondary onClick={refreshDetail}>Retry</Btn><Link href={path}>Back to list</Link></div>}
      />
    );
  }
  if (id && !record) {
    return (
      <Empty
        title="Document not found"
        text="This document does not exist or has been removed."
        action={<Link href={path}>Back to list</Link>}
      />
    );
  }

  const customer = record
    ? purchase
      ? state.suppliers.find((c) => c.id === (record as Purchase).supplierId)
      : state.customers.find((c) => c.id === (record as Bill).customerId)
    : null;

  function applySalesPeriod(days: number) {
    const end = TODAY;
    const start = new Date(new Date(`${TODAY}T12:00:00`).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    setDateFrom(start);
    setDateTo(end);
  }

  async function openFilteredBatchPreview() {
    setFilteredBatchLoading(true);
    try {
      const result = await fetchInvoicesPage({
        page: 1,
        limit: 100,
        search: deferredQ.trim() || undefined,
        status: status === 'All' ? undefined : status,
        hasDue: status === 'Unpaid' ? true : undefined,
        businessCategory: salesCategoryValue,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      if (result.total > 100) throw new Error(`The filters match ${result.total} invoices. Narrow the date range to 100 or fewer before creating the ZIP.`);
      if (!result.records.length) throw new Error('No invoices match the current filters.');
      setFilteredBatchBills(result.records);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not prepare filtered invoices.');
    } finally {
      setFilteredBatchLoading(false);
    }
  }

  function openInvoiceWhatsApp(invoice: Bill) {
    const snapshot = (invoice as any).customerSnapshot || customer || {};
    let rawDigits = String(invoice.billTo?.phone || snapshot.phone || '').replace(/\D/g, '');
    if (rawDigits.startsWith('0') && rawDigits.length === 11) {
      rawDigits = rawDigits.slice(1);
    }
    if (rawDigits.length === 10) {
      rawDigits = `91${rawDigits}`;
    }
    if (rawDigits.length !== 12 || !rawDigits.startsWith('91')) {
      return notify('Add a valid 10-digit customer phone number before opening WhatsApp.');
    }
    const phone = rawDigits;
    const number = (invoice as any).invoiceNumber || invoice.id;
    const invoiceTotal = (invoice as any).total ?? roundedTotal(invoice);
    const invoiceDue = (invoice as any).dueAmount ?? balance(state, invoice);
    const message = invoice.status === 'Draft'
      ? `Dear ${snapshot.name || invoice.billTo?.name || 'Customer'},\n\nPlease find draft invoice ${number} for ${money(invoiceTotal)} from ${state.settings.name || 'our billing team'}. This draft is not yet issued and may still change.\n\nThank you.`
      : `Dear ${snapshot.name || invoice.billTo?.name || 'Customer'},\n\nInvoice ${number} for ${money(invoiceTotal)} has been issued by ${state.settings.name || 'our billing team'}. Balance due: ${money(invoiceDue)}.\n\nPlease download the PDF here and attach it in WhatsApp before sending. Thank you for your business.`;
    try {
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    } catch {
      notify('Could not open WhatsApp. Please check popup permissions.');
    }
  }

  async function handleExecuteReversal(e: React.FormEvent) {
    e.preventDefault();
    if (!reversalReason.trim()) return notify('Reason for reversal is required.');
    setReversalBusy(true);
    try {
      let res: { success: boolean; error?: string } = { success: false };
      if (reversalModal.type === 'receipt') {
        res = await reversePurchaseReceiptApi(reversalModal.id, reversalReason.trim());
      } else if (reversalModal.type === 'return') {
        res = await reverseSupplierReturnApi(reversalModal.id, reversalReason.trim());
      } else if (reversalModal.type === 'payment') {
        res = await reverseSupplierPaymentApi(reversalModal.id, reversalReason.trim());
      } else if (reversalModal.type === 'allocation') {
        res = await reverseSupplierAllocationApi(reversalModal.id, reversalReason.trim());
      }

      if (res.success) {
        notify('Reversal recorded successfully.');
        setReversalModal({ open: false, type: 'receipt', id: '', title: '' });
        setReversalReason('');
        refreshDetail();
      } else {
        notify(res.error || 'Failed to execute reversal.');
      }
    } finally {
      setReversalBusy(false);
    }
  }

  return (
    <>
      {record && (
        <Link className="back-link" href={path}>
          <ArrowLeft size={14} />
          All invoices
        </Link>
      )}

      <PageHead
        title={record
          ? (purchase
              ? ((record as Purchase).purchaseNumber || record.id)
              : quotation
                ? ((record as any).quotationNumber || record.id)
                : ((record as any).invoiceNumber || record.id))
          : (purchase ? 'Purchases' : quotation ? 'Quotations' : 'Sales & invoices')}
        description={
          record
            ? `${customer?.name || 'Unknown'} · ${dateLabel(record.date)}`
            : purchase
              ? 'Purchase orders, stock receipts, supplier bills, and settlements.'
              : quotation
                ? 'Create clear estimates for products, PC builds and services.'
                : 'Every sale and service invoice, with payment status at a glance.'
        }
        actions={
          record ? (
            <>
              {!purchase && (
                <Btn secondary onClick={() => setPrint(true)}>
                  <Printer size={16} />
                  {record.status === 'Draft' ? 'Print draft / PDF' : 'Print / PDF'}
                </Btn>
              )}
              {!purchase && !quotation && (
                <Btn secondary onClick={() => openInvoiceWhatsApp(record as Bill)}>
                  <MessageCircle size={16} /> WhatsApp
                </Btn>
              )}
              {!purchase && !quotation && record.status === 'Issued' && (
                <Btn secondary onClick={() => setDeliveryChallanOpen(true)}>
                  <Truck size={16} />
                  Delivery Challan
                </Btn>
              )}
              {record.status === 'Draft' && (
                <>
                  <Link className="btn secondary" href={`/sales/new?edit=${id}`}>
                    Edit draft
                  </Link>
                  <Btn secondary onClick={() => setInvCancelOpen(true)}>
                    Discard draft
                  </Btn>
                  <Btn
                    onClick={() => {
                      const totalP = Math.round(((detailData?.raw?.grandTotalPaise != null ? detailData.raw.grandTotalPaise / 100 : roundedTotal(record))) * 100);
                      setIssueTargetDraft({
                        id: record.id,
                        version: detailData?.raw?.version ?? 1,
                        totalPaise: totalP,
                        customerId: (record as Bill).customerId || (detailData?.raw?.customerId ?? ''),
                      });
                      setIssueModalOpen(true);
                    }}
                  >
                    Issue invoice
                  </Btn>
                </>
              )}
              {record.status !== 'Draft' && (
                <>
                  {(detailData?.raw?.duePaise != null ? detailData.raw.duePaise > 0 : balance(state, record) > 0) && (
                    <Btn
                      onClick={() => {
                        if (isLive) {
                          setReceiptTargetInvoice({
                            id: record.id,
                            customerId: (record as Bill).customerId || (detailData?.raw?.customerId ?? ''),
                            dueAmount: detailData?.raw?.duePaise != null ? detailData.raw.duePaise : Math.round(balance(state, record) * 100),
                          });
                          setReceiptModalOpen(true);
                        } else {
                          setPayment(true);
                        }
                      }}
                    >
                      Receive payment
                    </Btn>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <Link className="btn secondary" href="/reports">
                Reports / Excel / PDF
              </Link>
              {purchase ? (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Btn secondary onClick={() => window.open(purchaseExportUrl('csv'), '_blank')}>
                    <Download size={14} />
                    CSV
                  </Btn>
                  <Btn secondary onClick={() => window.open(purchaseExportUrl('xlsx'), '_blank')}>
                    <Download size={14} />
                    XLSX
                  </Btn>
                  <Btn secondary onClick={() => window.open(purchaseExportUrl('pdf'), '_blank')}>
                    <Download size={14} />
                    PDF
                  </Btn>
                </div>
              ) : quotation ? (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Btn secondary onClick={() => window.open(quotationExportUrl('csv'), '_blank')}>
                    <Download size={14} />
                    CSV
                  </Btn>
                  <Btn secondary onClick={() => window.open(quotationExportUrl('xlsx'), '_blank')}>
                    <Download size={14} />
                    XLSX
                  </Btn>
                  <Btn secondary onClick={() => window.open(quotationExportUrl('pdf'), '_blank')}>
                    <Download size={14} />
                    PDF
                  </Btn>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Btn secondary onClick={() => window.open(invoiceExportUrl('csv'), '_blank')}>
                    <Download size={14} />
                    CSV
                  </Btn>
                  <Btn secondary onClick={() => window.open(invoiceExportUrl('xlsx'), '_blank')}>
                    <Download size={14} />
                    XLSX
                  </Btn>
                  <Btn secondary onClick={() => window.open(invoiceExportUrl('pdf'), '_blank')}>
                    <Download size={14} />
                    PDF
                  </Btn>
                  <span title="Preview every invoice matching the current filters, then download exact-layout PDFs as a ZIP">
                    <Btn secondary disabled={filteredBatchLoading} onClick={openFilteredBatchPreview}>
                      <Archive size={14} />
                      {filteredBatchLoading ? 'Preparing…' : 'Filtered PDF ZIP'}
                    </Btn>
                  </span>
                </div>
              )}
              {!quotation && !purchase && (
                <Link className="btn secondary" href="/sales/new?kind=Service">
                  Service invoice
                </Link>
              )}
              <Link href={path + '/new'} className="btn">
                <Plus size={16} />
                New invoice
              </Link>
            </>
          )
        }
      />

      {/* Summary Cards */}
      {!record && (
        purchase ? (
          <>
            {summaryError && (
              <div className="notice" role="alert" style={{ marginBottom: '1rem' }}>
                {summaryError} <Btn secondary onClick={() => setSummaryReload((value) => value + 1)}>Retry</Btn>
              </div>
            )}
            <div className="summary-dashboard" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <Card title="Draft orders">
                <div className="body-pad" role="button" tabIndex={0} onClick={() => setDocStatusFilter('Draft')}>
                  <h2>{isLive ? (summary ? summary.draftCount : '…') : state.purchases.filter((p) => p.documentStatus === 'Draft').length}</h2>
                  <p>Awaiting confirmation</p>
                </div>
              </Card>
              <Card title="Posted bill value">
                <div className="body-pad">
                  <h2>{isLive ? (summary ? money(summary.postedValuePaise / 100) : '…') : money(state.purchases.filter((p) => p.billStatus === 'Posted').reduce((n, p) => n + roundedTotal(p), 0))}</h2>
                  <p>Original value of posted supplier bills</p>
                </div>
              </Card>
              <Card title="Unpaid dues">
                <div className="body-pad" role="button" tabIndex={0} onClick={() => { setBillStatusFilter('Posted'); setPaymentStatusFilter('Unpaid'); }}>
                  <h2 style={{ color: 'var(--error, #e53935)' }}>
                    {isLive ? (summary ? money(summary.unpaidDuePaise / 100) : '…') : money(state.purchases.reduce((n, p) => n + balance(state, p), 0))}
                  </h2>
                  <p>Due to suppliers</p>
                </div>
              </Card>
              <Card title="Awaiting receipt">
                <div className="body-pad" role="button" tabIndex={0} onClick={() => setReceiptStatusFilter('NotReceived')}>
                  <h2>{isLive ? (summary ? summary.awaitingReceiptCount : '…') : state.purchases.filter((p) => p.receiptStatus === 'NotReceived' && p.billStatus === 'Posted').length}</h2>
                  <p>Bills posted, 0 stock received</p>
                </div>
              </Card>
              <Card title="Partly received">
                <div className="body-pad" role="button" tabIndex={0} onClick={() => setReceiptStatusFilter('PartlyReceived')}>
                  <h2>{isLive ? (summary ? summary.partlyReceivedCount : '…') : state.purchases.filter((p) => p.receiptStatus === 'PartlyReceived').length}</h2>
                  <p>Orders with remaining balance</p>
                </div>
              </Card>
              <Card title="Available advance">
                <div className="body-pad">
                  <h2>{isLive ? (summary ? money(summary.availableAdvancePaise / 100) : '…') : money(0)}</h2>
                  <p>Supplier prepayments available</p>
                </div>
              </Card>
            </div>
          </>
        ) : quotation ? (
          <div className="summary-dashboard" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            <Card title="Draft quotations">
              <div className="body-pad" role="button" tabIndex={0} onClick={() => setStatus('Draft')}>
                <h2>{salesSummary?.quotations?.draftCount ?? list.filter((q) => q.status === 'Draft').length}</h2>
                <p>Pending review</p>
              </div>
            </Card>
            <Card title="Shared quotations">
              <div className="body-pad" role="button" tabIndex={0} onClick={() => setStatus('Shared')}>
                <h2>{salesSummary?.quotations?.sentCount ?? list.filter((q) => q.status === 'Shared').length}</h2>
                <p>Sent to customers</p>
              </div>
            </Card>
            <Card title="Converted to invoice">
              <div className="body-pad" role="button" tabIndex={0} onClick={() => setStatus('Converted')}>
                <h2>{salesSummary?.quotations?.convertedCount ?? list.filter((q) => q.status === 'Converted').length}</h2>
                <p>Accepted and billed</p>
              </div>
            </Card>
            <Card title="Expired">
              <div className="body-pad" role="button" tabIndex={0} onClick={() => setStatus('Expired')}>
                <h2>{salesSummary?.quotations?.expiredCount ?? list.filter((q) => q.status === 'Expired').length}</h2>
                <p>Past valid-until date</p>
              </div>
            </Card>
            <Card title="Total quoted">
              <div className="body-pad">
                <h2>{money(salesSummary?.quotations?.totalQuotedPaise != null ? salesSummary.quotations.totalQuotedPaise / 100 : list.reduce((n, b) => n + roundedTotal(b), 0))}</h2>
                <p>Pipeline estimate total</p>
              </div>
            </Card>
          </div>
        ) : (
          <div className="summary-dashboard" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            <Card title="Draft invoices">
              <div className="body-pad" role="button" tabIndex={0} onClick={() => setStatus('Draft')}>
                <h2>{salesSummary?.invoices?.draftCount ?? list.filter((b) => b.status === 'Draft').length}</h2>
                <p>Unissued drafts</p>
              </div>
            </Card>
            <Card title="Issued invoices">
              <div className="body-pad">
                <h2>{salesSummary?.invoices?.issuedCount ?? list.filter((b) => b.status !== 'Draft').length}</h2>
                <p>Active sales bills</p>
              </div>
            </Card>
            <Card title="Gross invoiced">
              <div className="body-pad">
                <h2>{money(salesSummary?.invoices?.totalSalesPaise != null ? salesSummary.invoices.totalSalesPaise / 100 : list.reduce((n, b) => n + roundedTotal(b), 0))}</h2>
                <p>Total bill value</p>
              </div>
            </Card>
            <Card title="Payments collected">
              <div className="body-pad">
                <h2 style={{ color: 'var(--success, #2e7d32)' }}>
                  {money(salesSummary?.invoices?.totalPaidPaise != null ? salesSummary.invoices.totalPaidPaise / 100 : list.reduce((n, b) => n + paid(state, b.id), 0))}
                </h2>
                <p>Settled receipts</p>
              </div>
            </Card>
            <Card title="Outstanding dues">
              <div className="body-pad" role="button" tabIndex={0} onClick={() => setStatus('Unpaid')}>
                <h2 style={{ color: 'var(--error, #e53935)' }}>
                  {money(salesSummary?.invoices?.totalDuePaise != null ? salesSummary.invoices.totalDuePaise / 100 : list.reduce((n, b) => n + balance(state, b), 0))}
                </h2>
                <p>Pending customer collections</p>
              </div>
            </Card>
            <Card title="Available advances">
              <div className="body-pad">
                <h2>{money(salesSummary?.totalCustomerAdvanceAvailablePaise != null ? salesSummary.totalCustomerAdvanceAvailablePaise / 100 : 0)}</h2>
                <p>Customer prepaid deposits</p>
              </div>
            </Card>
          </div>
        )
      )}

      {record ? (
        <>
          <div className="document-status-strip screen-only">
            <span>
              <Badge>{record.status}</Badge>
            </span>
            {purchase && (
              <>
                <span title="Order lifecycle state">Doc: <Badge>{(record as Purchase).documentStatus || 'Confirmed'}</Badge></span>
                <span title="Payable status">Bill: <Badge>{(record as Purchase).billStatus || 'Posted'}</Badge></span>
                <span title="Physical stock received">Stock: <Badge>{(record as Purchase).receiptStatus || 'Received'}</Badge></span>
              </>
            )}
            <span>
              Total <b>{money(roundedTotal(record))}</b>
            </span>
            {!quotation && record.status !== 'Draft' && (
              <>
                <span>
                  Paid <b>{money(isLive && (record as any).paidAmount != null ? (record as any).paidAmount : paid(state, record.id))}</b>
                </span>
                <span>
                  Balance <b>{money(isLive && (record as any).dueAmount != null ? (record as any).dueAmount : balance(state, record))}</b>
                </span>
                <Badge>
                  {(record as any).paymentStatus === 'PartlyPaid'
                    ? 'Partly paid'
                    : (record as any).paymentStatus === 'Paid'
                    ? 'Paid'
                    : (record as any).paymentStatus === 'Unpaid'
                      ? 'Unpaid'
                      : (isLive && (record as any).dueAmount != null ? (record as any).dueAmount === 0 : balance(state, record) === 0)
                        ? 'Paid'
                        : (isLive && (record as any).paidAmount != null ? (record as any).paidAmount > 0 : paid(state, record.id) > 0)
                          ? 'Partly paid'
                          : 'Unpaid'}
                </Badge>
              </>
            )}
            {!quotation && record.status === 'Draft' && <Badge>Not issued · no receipt</Badge>}
          </div>

          {purchase ? (
            <div className="stack spaced">
              <div className="tabs">
                {(['Overview', 'Receipts', 'Payments', 'Returns', 'Credit notes'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={detailTab === t ? 'active' : ''}
                    onClick={() => setDetailTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {detailTab === 'Overview' && (
                <Card title="Purchase items">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Type</th>
                          <th>Ordered</th>
                          <th>Received</th><th>Returned to supplier</th>
                          <th>Rate</th>
                          <th>Serials</th>
                          <th>Total</th><th>Paid / advance applied</th><th>Credit applied</th><th>Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {record.lines.map((l: any, i: number) => (
                          <tr key={l.clientLineKey || i}>
                            <td>{l.name}</td>
                            <td><Badge>{l.lineType || 'Product'}</Badge></td>
                            <td>{l.quantityOrdered ?? l.qty}</td>
                            <td>{l.quantityReceived ?? (record.status === 'Received' ? l.qty : 0)}</td>
                            <td>{l.quantityReturned ?? 0}</td><td>{money(l.rate)}</td>
                            <td>{l.serials?.join(', ') || (l.isSerialTracked ? 'See receipt lots for serial numbers' : 'Quantity tracked — no serial selection')}</td>
                            <td>{money(l.total ?? lineTotal(l, record.inclusive).total)}</td><td>{money(l.paid ?? 0)}</td><td>{money(l.credited ?? 0)}</td><td>{money(l.due ?? 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="body-pad spaced">
                    <p>{record.notes || 'No printed notes.'}</p>
                    <p>Supplier reference: {(record as Purchase).reference || '—'}</p>
                    <p>Due date: {dateLabel(record.due)}</p>
                  </div>
                </Card>
              )}

              {detailTab === 'Receipts' && (
                <Card title="Linked Stock Receipts">
                  <div className="body-pad notice" style={{ margin: 12 }}>
                    <strong>Undo receipt is for correcting a mistaken stock entry.</strong> It removes this receipt's untouched
                    stock but does not cancel the supplier bill or reduce the amount payable. To physically send goods back to
                    the supplier, use <b>Record supplier return</b> in the Returns tab.
                  </div>
                  {rcptError ? (
                    <div className="body-pad stack">
                      <p className="error">{rcptError}</p>
                      <Btn secondary onClick={loadReceipts}>Retry</Btn>
                    </div>
                  ) : (
                    <>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Receipt Number</th>
                              <th>Date</th>
                              <th>Received Lines</th>
                              <th>Status</th>
                              <th>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(rcptList.length ? rcptList : (detailData?.receipts || [])).map((rcpt: any) => (
                              <tr key={rcpt._id || rcpt.id}>
                                <td><strong>{rcpt.receiptNumber}</strong></td>
                                <td>{dateLabel(rcpt.date || rcpt.receiptDate)}</td>
                                <td>
                                  {(rcpt.lines || []).map((l: any, idx: number) => (
                                    <div key={idx}>
                                      {l.productName || l.lineId}: {l.quantityReceived} unit(s)
                                    </div>
                                  ))}
                                </td>
                                <td>
                                  <Badge>{rcpt.isReversed ? 'Reversed' : 'Completed'}</Badge>
                                </td>
                                <td>
                                  {!rcpt.isReversed && (
                                    rcpt.canReverse ? (
                                      <Btn
                                        secondary
                                        onClick={() =>
                                          setReversalModal({
                                            open: true,
                                            type: 'receipt',
                                            id: rcpt._id || rcpt.id,
                                            title: `Undo Stock Receipt ${rcpt.receiptNumber}`,
                                          })
                                        }
                                      >
                                        <RotateCcw size={14} /> Undo receipt error
                                      </Btn>
                                    ) : (
                                      <small className="muted" title={rcpt.reverseBlockReason}>
                                        {rcpt.reverseBlockReason || 'Cannot reverse'}
                                      </small>
                                    )
                                  )}
                                </td>
                              </tr>
                            ))}
                            {!(rcptList.length || detailData?.receipts?.length) && (
                              <tr>
                                <td colSpan={5} className="muted body-pad">
                                  {rcptLoading ? 'Loading stock receipts…' : 'No stock receipt records linked to this purchase yet.'}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {rcptTotalPages > 1 && (
                        <div className="table-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>Page {rcptPage} of {rcptTotalPages} ({rcptTotal} receipts)</span>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <Btn secondary disabled={rcptPage <= 1 || rcptLoading} onClick={() => setRcptPage((p) => p - 1)}>Previous</Btn>
                            <Btn secondary disabled={rcptPage >= rcptTotalPages || rcptLoading} onClick={() => setRcptPage((p) => p + 1)}>Next</Btn>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </Card>
              )}

              {detailTab === 'Payments' && (
                <Card title="Linked Payments and Allocations">
                  {allocError ? (
                    <div className="body-pad stack">
                      <p className="error">{allocError}</p>
                      <Btn secondary onClick={loadAllocations}>Retry</Btn>
                    </div>
                  ) : (
                    <>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Date</th>
                              <th>Payment / Allocation ID</th>
                              <th>Account</th>
                              <th>Amount</th>
                              <th>Status</th>
                              <th>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(allocList.length ? allocList : (detailData?.allocations || [])).map((alloc: any) => (
                              <tr key={alloc._id || alloc.id}>
                                <td>{dateLabel(alloc.date || alloc.effectiveDate || record.date)}</td>
                                <td>Allocation: {alloc.allocationNumber || alloc._id || alloc.id}</td>
                                <td>Advance / Direct</td>
                                <td>{money((alloc.amountPaise || 0) / 100)}</td>
                                <td><Badge>{alloc.isReversed ? 'Reversed' : 'Active'}</Badge></td>
                                <td>
                                  {!alloc.isReversed && (
                                    alloc.canReverse ? (
                                      <Btn
                                        secondary
                                        onClick={() =>
                                          setReversalModal({
                                            open: true,
                                            type: 'allocation',
                                            id: alloc._id || alloc.id,
                                            title: 'Reverse Payment Allocation',
                                          })
                                        }
                                      >
                                        <RotateCcw size={14} /> Reverse allocation
                                      </Btn>
                                    ) : (
                                      <small className="muted">{alloc.reverseBlockReason || 'Locked'}</small>
                                    )
                                  )}
                                </td>
                              </tr>
                            ))}
                            {!(allocList.length || detailData?.allocations?.length) && (
                              <tr>
                                <td colSpan={6} className="muted body-pad">
                                  {allocLoading ? 'Loading payment allocations…' : 'No settlement allocations recorded for this bill.'}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {allocTotalPages > 1 && (
                        <div className="table-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>Page {allocPage} of {allocTotalPages} ({allocTotal} allocations)</span>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <Btn secondary disabled={allocPage <= 1 || allocLoading} onClick={() => setAllocPage((p) => p - 1)}>Previous</Btn>
                            <Btn secondary disabled={allocPage >= allocTotalPages || allocLoading} onClick={() => setAllocPage((p) => p + 1)}>Next</Btn>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </Card>
              )}

              {detailTab === 'Returns' && (
                <Card title="Linked Supplier Returns">
                  <div className="body-pad" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                    <p className="muted" style={{ margin: 0 }}>Physical goods sent back to the supplier appear here. The bill due changes only after the supplier credit note is accepted.</p>
                    <Link className="btn secondary" href={`/returns?reference=${id}`}>Record supplier return</Link>
                  </div>
                  {retError ? (
                    <div className="body-pad stack">
                      <p className="error">{retError}</p>
                      <Btn secondary onClick={loadReturns}>Retry</Btn>
                    </div>
                  ) : (
                    <>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Return ID</th>
                              <th>Date</th>
                              <th>Reason</th>
                              <th>Items</th>
                              <th>Status</th>
                              <th>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(retList.length ? retList : (detailData?.returns || [])).map((ret: any) => (
                              <tr key={ret._id || ret.id}>
                                <td>{ret.returnNumber || ret._id || ret.id}</td>
                                <td>{dateLabel(ret.date)}</td>
                                <td>{ret.reason}</td>
                                <td>
                                  {ret.productName || detailData?.purchase?.lines?.find((line: any) => line.lineId === ret.purchaseLineId)?.productSnapshot?.name || ret.productId || 'Product'}: {ret.quantity || 0} unit(s)
                                  {ret.serials?.length > 0 && <div className="muted">Serials: {ret.serials.join(', ')}</div>}
                                </td>
                                <td><Badge>{ret.isReversed ? 'Reversed' : ret.status === 'PendingCreditAcceptance' ? 'Awaiting supplier credit' : ret.status === 'CreditAccepted' ? 'Credit accepted' : ret.status || 'Recorded'}</Badge></td>
                                <td>
                                  {!ret.isReversed && (
                                    ret.canReverse ? (
                                      <Btn
                                        secondary
                                        onClick={() =>
                                          setReversalModal({
                                            open: true,
                                            type: 'return',
                                            id: ret._id || ret.id,
                                            title: `Reverse Return ${ret.returnNumber || ret.id}`,
                                          })
                                        }
                                      >
                                        <RotateCcw size={14} /> Reverse return
                                      </Btn>
                                    ) : (
                                      <small className="muted">{ret.reverseBlockReason || 'Cannot reverse'}</small>
                                    )
                                  )}
                                </td>
                              </tr>
                            ))}
                            {!(retList.length || detailData?.returns?.length) && (
                              <tr>
                                <td colSpan={6} className="muted body-pad">
                                  {retLoading ? 'Loading returns…' : 'No returns linked to this purchase.'}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {retTotalPages > 1 && (
                        <div className="table-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>Page {retPage} of {retTotalPages} ({retTotal} returns)</span>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <Btn secondary disabled={retPage <= 1 || retLoading} onClick={() => setRetPage((p) => p - 1)}>Previous</Btn>
                            <Btn secondary disabled={retPage >= retTotalPages || retLoading} onClick={() => setRetPage((p) => p + 1)}>Next</Btn>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </Card>
              )}
              {detailTab === 'Credit notes' && (
                <Card title="Supplier credit notes">
                  {cnError ? (
                    <div className="body-pad stack">
                      <p className="error">{cnError}</p>
                      <Btn secondary onClick={loadCreditNotes}>Retry</Btn>
                    </div>
                  ) : (
                    <>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Credit note</th>
                              <th>Date</th>
                              <th>Return</th>
                              <th>Amount</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(cnList.length ? cnList : (detailData?.creditNotes || [])).map((note: any) => (
                              <tr key={note._id || note.id}>
                                <td>{note.creditNoteNumber || note.supplierCreditNoteNumber || note._id}</td>
                                <td>{dateLabel(note.date)}</td>
                                <td>{note.returnNumber || note.returnId || 'Standalone'}</td>
                                <td>{money((note.amountPaise || 0) / 100)}</td>
                                <td><Badge>{note.isReversed ? 'Reversed' : 'Accepted'}</Badge></td>
                              </tr>
                            ))}
                            {!(cnList.length || detailData?.creditNotes?.length) && (
                              <tr>
                                <td colSpan={5} className="muted body-pad">
                                  {cnLoading ? 'Loading credit notes…' : 'No credit notes linked to this purchase.'}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {cnTotalPages > 1 && (
                        <div className="table-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>Page {cnPage} of {cnTotalPages} ({cnTotal} credit notes)</span>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <Btn secondary disabled={cnPage <= 1 || cnLoading} onClick={() => setCnPage((p) => p - 1)}>Previous</Btn>
                            <Btn secondary disabled={cnPage >= cnTotalPages || cnLoading} onClick={() => setCnPage((p) => p + 1)}>Next</Btn>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </Card>
              )}
            </div>
          ) : (
            <InvoicePaper bill={record as Bill} />
          )}

          <div className="detail-grid spaced screen-only">
            <Card title="Payment history">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Account</th>
                      <th>Purpose</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detailData?.receipts?.length
                      ? detailData.receipts.map((receipt: any) => ({
                          id: receipt._id || receipt.id,
                          date: receipt.date,
                          account: receipt.components?.[0]?.account || 'Cash',
                          purpose: `${receipt.receiptNumber || 'Receipt'} · ${receipt.components?.[0]?.method || 'Cash'}`,
                          amount: (receipt.totalAmountPaise || 0) / 100,
                        }))
                      : state.payments.filter((p) => p.reference === record.id)
                    ).map((p: any) => (
                      <tr key={p.id}>
                        <td>{p.date}</td>
                        <td>{p.account}</td>
                        <td>{p.purpose}</td>
                        <td>{money(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!detailData?.receipts?.length && !state.payments.some((p) => p.reference === record.id) && (
                <Empty
                  title="No payments recorded"
                  text="Recorded customer payments for this invoice will appear here."
                />
              )}
            </Card>

            <Card title="Related actions">
              <div className="body-pad stack">
                <Link
                  className="text-link"
                  href={`/customers/${customer?.id || (record as Bill).customerId}`}
                >
                  Open customer profile <ArrowUpRight size={15} />
                </Link>
              </div>
            </Card>
          </div>
        </>
      ) : (
        <>
        {!quotation && !purchase && (
          <div className="tabs" aria-label="Invoice views" style={{marginBottom: '1rem'}}>
            <button type="button" className={status !== 'Unpaid' ? 'active' : ''} onClick={() => setStatus('All')}>All invoices</button>
            <button type="button" className={status === 'Unpaid' ? 'active' : ''} onClick={() => setStatus('Unpaid')}>Outstanding</button>
          </div>
        )}
        <Card>
          {!quotation && !purchase && status === 'Unpaid' && (
            <div className="body-pad notice" style={{margin: 12}}><strong>Outstanding invoices</strong> — only issued invoices with a balance due are shown.</div>
          )}
          <div className="toolbar" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
            <SearchBox value={q} onChange={setQ} placeholder="Search document or customer…" />

            {purchase ? (
              <>
                <select
                  aria-label="Document status"
                  value={docStatusFilter}
                  onChange={(e) => setDocStatusFilter(e.target.value)}
                >
                  <option value="All">All doc states</option>
                  <option value="Draft">Draft</option>
                  <option value="Confirmed">Confirmed</option>
                  <option value="Cancelled">Cancelled</option>
                </select>

                <select
                  aria-label="Bill status"
                  value={billStatusFilter}
                  onChange={(e) => setBillStatusFilter(e.target.value)}
                >
                  <option value="All">All bill states</option>
                  <option value="NotPosted">Not posted</option>
                  <option value="Posted">Posted</option>
                </select>

                <select
                  aria-label="Receipt status"
                  value={receiptStatusFilter}
                  onChange={(e) => setReceiptStatusFilter(e.target.value)}
                >
                  <option value="All">All receipt states</option>
                  <option value="NotReceived">Not received</option>
                  <option value="PartlyReceived">Partly received</option>
                  <option value="Received">Received</option>
                  <option value="ClosedPartlyReceived">Closed partly received</option>
                </select>

                <select
                  aria-label="Payment status"
                  value={paymentStatusFilter}
                  onChange={(e) => setPaymentStatusFilter(e.target.value)}
                >
                  <option value="All">All payment states</option>
                  <option value="Unpaid">Unpaid</option>
                  <option value="PartlyPaid">Partly paid</option>
                  <option value="Paid">Paid</option>
                </select>
              </>
            ) : (
              <select
                aria-label="Document status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="All">All statuses</option>
                {(quotation
                  ? ['Draft', 'Shared', 'Converted', 'Expired', 'Cancelled']
                  : ['Draft', 'Issued', 'Paid', 'PartlyPaid', 'Unpaid', 'Cancelled']
                ).map((s) => (
                  <option key={s} value={s}>{s === 'Unpaid' ? 'Outstanding' : s === 'PartlyPaid' ? 'Partly paid' : s}</option>
                ))}
              </select>
            )}

            {!purchase && !quotation && (
              <select
                aria-label="Business category filter"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option>All categories</option>
                <option>New goods</option>
                <option>Used goods</option>
                <option>Service</option>
              </select>
            )}

            {!purchase && !quotation ? (
              <>
                <button type="button" className="link-button" onClick={() => applySalesPeriod(1)}>Today</button>
                <button type="button" className="link-button" onClick={() => applySalesPeriod(7)}>7 days</button>
                <button type="button" className="link-button" onClick={() => applySalesPeriod(30)}>30 days</button>
                <Field label="From"><input aria-label="Sales from date" type="date" value={dateFrom} max={dateTo || TODAY} onChange={(e) => setDateFrom(e.target.value)} /></Field>
                <Field label="To"><input aria-label="Sales to date" type="date" value={dateTo} min={dateFrom} max={TODAY} onChange={(e) => setDateTo(e.target.value)} /></Field>
                {(dateFrom || dateTo) && <button type="button" className="link-button" onClick={() => {setDateFrom(''); setDateTo('');}}>All dates</button>}
              </>
            ) : (
              <>
                <input aria-label="Document date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                {date && <button type="button" className="link-button" onClick={() => setDate('')}>Clear date</button>}
              </>
            )}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>{purchase ? 'Supplier' : 'Customer'}</th>
                  <th>Date</th>
                  <th>Total</th>
                  {!quotation && <th>Balance due</th>}
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link className="record-link" href={path + '/' + b.id}>
                        {purchase
                          ? ((b as Purchase).purchaseNumber || b.id)
                          : quotation
                            ? ((b as any).quotationNumber || b.id)
                            : ((b as any).invoiceNumber || b.id)}
                      </Link>
                      <small>
                        {purchase
                          ? (b as Purchase).reference || 'No ref'
                          : (b as Bill).kind + ' · ' + (b as Bill).category}
                      </small>
                    </td>
                    <td>
                      {purchase
                        ? (b as any).supplierSnapshot?.name || state.suppliers.find((c) => c.id === (b as Purchase).supplierId)?.name
                        : (b as any).customerSnapshot?.name || (b as any).customerName || state.customers.find((c) => c.id === (b as Bill).customerId)?.name || 'Walk-in customer'}
                    </td>
                    <td>{dateLabel(b.date)}</td>
                    <td className="amount">{money(purchase && isLive ? (b as Purchase).total || 0 : isLive && (b as any).total != null ? (b as any).total : roundedTotal(b))}</td>
                    {!quotation && <td>{b.status === 'Draft' ? '—' : money(purchase && isLive ? (b as Purchase).dueAmount || 0 : isLive && (b as any).dueAmount != null ? (b as any).dueAmount : balance(state, b))}</td>}
                    <td>
                      {purchase ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'flex-start' }}>
                          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                            <span title="Document lifecycle state"><Badge>{(b as Purchase).documentStatus || 'Confirmed'}</Badge></span>
                            <span title="Supplier bill status"><Badge>{(b as Purchase).billStatus || 'Posted'}</Badge></span>
                          </div>
                          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                            <span title="Physical stock receipt"><Badge>{(b as Purchase).receiptStatus || 'Received'}</Badge></span>
                            <span title="Supplier payment settlement">
                              <Badge>
                                {(b as Purchase).paymentStatus || (
                                  (b as Purchase).dueAmount === 0 || balance(state, b) === 0
                                    ? 'Paid'
                                    : ((b as any).paidAmount || paid(state, b.id)) > 0
                                      ? 'PartlyPaid'
                                      : 'Unpaid'
                                )}
                              </Badge>
                            </span>
                          </div>
                        </div>
                      ) : (
                        <Badge>
                          {quotation
                            ? b.status
                            : b.status === 'Draft'
                              ? 'Draft'
                              : (b as any).paymentStatus === 'PartlyPaid'
                                ? 'Partly paid'
                              : (b as any).paymentStatus === 'Paid'
                                ? 'Paid'
                              : (b as any).paymentStatus === 'Unpaid'
                                ? 'Unpaid'
                              : (isLive && (b as any).dueAmount != null ? (b as any).dueAmount === 0 : balance(state, b) === 0)
                                ? 'Paid'
                                : (isLive && (b as any).paidAmount != null ? (b as any).paidAmount > 0 : paid(state, b.id) > 0)
                                  ? 'Partly paid'
                                  : 'Unpaid'}
                        </Badge>
                      )}
                    </td>
                    <td>
                      <Link className="text-link" href={path + '/' + b.id}>
                        View <ArrowUpRight size={15} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!list.length && (
            <Empty
              title={
                (purchase && purchaseListLoading) || (quotation && quotationListLoading) || (!purchase && !quotation && invoiceListLoading)
                  ? 'Loading live records…'
                  : 'No matching records'
              }
              text={
                (purchase && purchaseListLoading) || (quotation && quotationListLoading) || (!purchase && !quotation && invoiceListLoading)
                  ? 'Records are being loaded from your company account.'
                  : 'No records match the selected filters.'
              }
            />
          )}
          <div className="table-footer">
            {purchase && isLive && purchasePageData ? (
              <>
                <span>{purchasePageData.total} matching records · Page {purchasePage} of {purchasePageData.totalPages}</span>
                <div className="actions">
                  <Btn secondary disabled={purchasePage <= 1 || purchaseListLoading} onClick={() => setPurchasePage(p => p - 1)}>Previous</Btn>
                  <Btn secondary disabled={purchasePage >= purchasePageData.totalPages || purchaseListLoading} onClick={() => setPurchasePage(p => p + 1)}>Next</Btn>
                </div>
              </>
            ) : quotation && isLive && quotationPageData ? (
              <>
                <span>{quotationPageData.total} matching quotations · Page {quotationPage} of {quotationPageData.totalPages}</span>
                <div className="actions">
                  <Btn secondary disabled={quotationPage <= 1 || quotationListLoading} onClick={() => setQuotationPage(p => p - 1)}>Previous</Btn>
                  <Btn secondary disabled={quotationPage >= quotationPageData.totalPages || quotationListLoading} onClick={() => setQuotationPage(p => p + 1)}>Next</Btn>
                </div>
              </>
            ) : !purchase && !quotation && isLive && invoicePageData ? (
              <>
                <span>{invoicePageData.total} matching invoices · Page {invoicePage} of {invoicePageData.totalPages}</span>
                <div className="actions">
                  <Btn secondary disabled={invoicePage <= 1 || invoiceListLoading} onClick={() => setInvoicePage(p => p - 1)}>Previous</Btn>
                  <Btn secondary disabled={invoicePage >= invoicePageData.totalPages || invoiceListLoading} onClick={() => setInvoicePage(p => p + 1)}>Next</Btn>
                </div>
              </>
            ) : (
              <span>{list.length} records · All matching records shown</span>
            )}
          </div>
        </Card>
        </>
      )}

      {/* Reversal Reason Modal */}
      {reversalModal.open && (
        <Modal title={reversalModal.title} onClose={() => setReversalModal((m) => ({ ...m, open: false }))}>
          <form onSubmit={handleExecuteReversal}>
            <div className="form-body">
              <p>
                {reversalModal.type === 'receipt'
                  ? 'This only undoes an incorrect stock receipt. The supplier bill and amount payable remain unchanged. It is allowed only while every received unit is untouched. Use a supplier return for goods physically sent back.'
                  : reversalModal.type === 'return'
                    ? 'This cancels the recorded supplier return and restores its stock. It is blocked after the linked supplier credit has downstream use.'
                    : 'Reversal restores the prior accounting state. A clear reason is required for the audit log.'}
              </p>
              <Field label="Reason for reversal *">
                <input
                  required
                  autoFocus
                  placeholder="e.g. Wrong items scanned, data entry error..."
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                />
              </Field>
            </div>
            <div className="form-actions">
              <Btn secondary onClick={() => setReversalModal((m) => ({ ...m, open: false }))}>
                Cancel
              </Btn>
              <Btn danger type="submit" disabled={reversalBusy}>
                {reversalBusy ? 'Reversing…' : 'Confirm reversal'}
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {print && record && !purchase && (
        <PrintDialog bills={[record as Bill]} onClose={() => setPrint(false)} />
      )}

      {payment && record && (
        <PaymentDialog record={record} onClose={() => setPayment(false)} />
      )}

      {cancel && record && (
        <Modal title="Cancel quotation?" onClose={() => setCancel(false)}>
          <div className="form-body">
            <p>
              The quotation will remain in history as cancelled. No stock or payments are affected.
            </p>
          </div>
          <div className="form-actions">
            <Btn secondary onClick={() => setCancel(false)}>
              Keep quotation
            </Btn>
            <Btn
              danger
              onClick={() => {
                setState((s) => ({
                  ...s,
                  bills: s.bills.map((b) => (b.id === id ? { ...b, status: 'Cancelled' } : b)),
                }));
                setCancel(false);
                notify('Quotation cancelled.');
              }}
            >
              Cancel quotation
            </Btn>
          </div>
        </Modal>
      )}

      {/* Live Sales Phase 4 Lifecycle Modals */}
      {issueModalOpen && issueTargetDraft && (
        <IssueInvoiceModal
          isOpen={issueModalOpen}
          draft={issueTargetDraft}
          onClose={() => {
            setIssueModalOpen(false);
            setIssueTargetDraft(null);
          }}
          onIssued={(issuedInvoice: any) => {
            setIssueModalOpen(false);
            setIssueTargetDraft(null);
            notify(`Invoice ${issuedInvoice.invoiceNumber || issuedInvoice.id} issued successfully!`);
            refreshDetail();
            router.push(`/sales/${issuedInvoice.id || issueTargetDraft.id}`);
          }}
        />
      )}

      {receiptModalOpen && receiptTargetInvoice && (
        <RecordReceiptModal
          isOpen={receiptModalOpen}
          preselectedInvoice={receiptTargetInvoice}
          onClose={() => {
            setReceiptModalOpen(false);
            setReceiptTargetInvoice(null);
          }}
          onSuccess={() => {
            setReceiptModalOpen(false);
            setReceiptTargetInvoice(null);
            notify('Payment received and settled.');
            refreshDetail();
          }}
        />
      )}

      {invCancelOpen && record && (
        <InvoiceCancelModal
          isOpen={invCancelOpen}
          invoiceId={record.id}
          version={detailData?.raw?.version || 1}
          onClose={() => setInvCancelOpen(false)}
          onSuccess={() => {
            setInvCancelOpen(false);
            notify('Invoice draft discarded.');
            router.push('/sales');
          }}
        />
      )}

      {deliveryChallanOpen && record && (
        <DeliveryChallanModal
          docData={record as any}
          onClose={() => setDeliveryChallanOpen(false)}
        />
      )}
      {!!filteredBatchBills.length && (
        <PrintDialog bills={filteredBatchBills} onClose={() => setFilteredBatchBills([])} />
      )}
    </>
  );
}
