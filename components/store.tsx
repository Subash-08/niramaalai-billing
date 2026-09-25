'use client';
import {createContext, useContext, useState, useEffect, useCallback, ReactNode} from 'react';
import {seed} from '@/lib/seed';
import {State, Customer, Supplier, Product, Bill, Reservation, Enquiry, TODAY} from '@/lib/domain';
import {InvoiceTemplate, ServiceItem} from '@/lib/extensions';
import {uploadFile} from '@/lib/upload';
import {
  mapCustomerFromApi,
  mapSupplierFromApi,
  mapProductFromApi,
  mapServiceFromApi,
  mapTemplateFromApi,
  mapPurchaseFromApi,
  mapPaymentFromApi,
  mapInvoiceFromApi,
  mapQuotationFromApi,
  mapReservationFromApi,
  mapEnquiryFromApi,
} from '@/lib/mappers';

export type OpeningStatus = {
  status: 'Draft' | 'Finalized';
  isFinalized: boolean;
  cutoffDate: string;
  openingCashPaise: number;
  openingBankPaise: number;
  draftVersion?: number;
};

export type CompanySession = {
  user?: {name?: string; email?: string};
  company?: {name?: string};
  profitUnlocked?: boolean;
  businessDataMode?: 'live' | 'demo-imported';
};

export type PaginationResult<T> = {
  records: T[];
  total: number;
  page: number;
  totalPages: number;
};

type Store = {
  state: State;
  setState: React.Dispatch<React.SetStateAction<State>>;
  role: string;
  setRole: (r: string) => void;
  notify: (s: string) => void;
  run: (fn: (s: State) => State, message: string) => boolean;

  // Phase 2: Live Backend Master Data State & Operations
  isLive: boolean;
  businessDataMode: 'demo-only' | 'live' | 'demo-imported';
  companySession: CompanySession | null;
  openingStatus: OpeningStatus | null;
  isLoading: boolean;
  refreshMasterData: () => Promise<void>;

  saveSettingsApi: (f: Partial<State['settings']>, logoFile?: File) => Promise<boolean>;
  updateLogoApi: (file: File | null) => Promise<boolean>;
  saveCustomerApi: (c: any, id?: string) => Promise<{success: boolean; warning?: string}>;
  archiveCustomerApi: (id: string) => Promise<boolean>;
  restoreCustomerApi: (id: string) => Promise<boolean>;
  saveSupplierApi: (s: any, id?: string) => Promise<{success: boolean; warning?: string}>;
  archiveSupplierApi: (id: string) => Promise<boolean>;
  restoreSupplierApi: (id: string) => Promise<boolean>;
  saveProductApi: (p: any, id?: string) => Promise<boolean>;
  adjustProductStockApi: (id: string, delta: number, serials: string[], reason: string, idempotencyKey?: string) => Promise<boolean>;
  archiveProductApi: (id: string) => Promise<boolean>;
  restoreProductApi: (id: string) => Promise<boolean>;
  saveServiceApi: (srv: any, id?: string) => Promise<boolean>;
  archiveServiceApi: (id: string) => Promise<boolean>;
  restoreServiceApi: (id: string) => Promise<boolean>;
  saveTemplateApi: (t: any, id?: string) => Promise<boolean>;
  setDefaultTemplateApi: (id: string) => Promise<boolean>;
  archiveTemplateApi: (id: string) => Promise<boolean>;
  restoreTemplateApi: (id: string) => Promise<boolean>;

  fetchOpeningDraftApi: () => Promise<any>;
  saveOpeningDraftApi: (draft: any) => Promise<{success: boolean; draftVersion?: number}>;
  finalizeOpeningApi: (options?: {expectedDraftVersion?: number}) => Promise<boolean>;
  importDemoMasterDataApi: () => Promise<boolean>;

  // Server-side pagination and queries
  fetchCustomersPage: (query?: {page?: number; limit?: number; q?: string; status?: string; type?: string}) => Promise<PaginationResult<Customer>>;
  fetchSuppliersPage: (query?: {page?: number; limit?: number; q?: string; status?: string}) => Promise<PaginationResult<Supplier>>;
  fetchProductsPage: (query?: {page?: number; limit?: number; q?: string; category?: string; status?: string}) => Promise<PaginationResult<Product>>;

  // Phase 3 & 3.5: Purchases, Stock Receipt, Inventory and Supplier Settlement
  savePurchaseApi: (p: any, postImmediately?: boolean, existingId?: string, version?: number) => Promise<{success: boolean; purchase?: any; error?: string}>;
  confirmPurchaseOrderApi: (id: string, expectedVersion?: number) => Promise<{success: boolean; purchase?: any; error?: string}>;
  postPurchaseBillApi: (id: string, invoiceNumber: string, invoiceDate: string, expectedVersion?: number) => Promise<{success: boolean; purchase?: any; error?: string}>;
  receivePurchaseStockApi: (id: string, lines: any[], options?: {idempotencyKey: string; receiptDate: string}) => Promise<boolean>;
  recordReceiveShortcutApi: (payload: any) => Promise<{success: boolean; purchase?: any; receipt?: any; error?: string}>;
  recordReceiveAndPayShortcutApi: (payload: any) => Promise<{success: boolean; purchase?: any; receipt?: any; payment?: any; error?: string}>;
  recordSupplierPaymentApi: (payload: any) => Promise<{success: boolean; payment?: any; error?: string}>;
  closePurchaseRemainderApi: (id: string, expectedVersion?: number, reason?: string) => Promise<boolean>;
  cancelPurchaseApi: (id: string, expectedVersion?: number) => Promise<boolean>;
  reversePurchaseReceiptApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  reverseSupplierReturnApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  reverseSupplierPaymentApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  reverseSupplierAllocationApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  reverseSupplierCreditNoteApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  reverseSupplierRefundApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  quarantineStockApi: (payload: {lotId: string; quantity: number; serials?: string[]; reason: string}) => Promise<{success: boolean; error?: string}>;
  restoreStockApi: (payload: {lotId: string; quantity: number; serials?: string[]; reason: string}) => Promise<{success: boolean; error?: string}>;
  recordSupplierReturnApi: (payload: any) => Promise<{success: boolean; returnDoc?: any; error?: string}>;
  acceptReturnCreditNoteApi: (returnId: string, payload: any) => Promise<{success: boolean; creditNote?: any; error?: string}>;
  recordSupplierRefundApi: (payload: any) => Promise<{success: boolean; refund?: any; error?: string}>;
  allocateSupplierAdvanceApi: (payload: any) => Promise<{success: boolean; error?: string}>;
  fetchPurchaseDetailApi: (id: string) => Promise<any>;
  fetchSupplierStatementApi: (supplierId: string, params?: any) => Promise<any>;
  fetchSupplierPayablesApi: (supplierId: string, query?: any) => Promise<any>;
  fetchSupplierAdvancesApi: (supplierId: string, query?: any) => Promise<any>;
  fetchPurchasesPage: (query?: {
    page?: number;
    limit?: number;
    hasDue?: boolean;
    supplierId?: string;
    productId?: string;
    status?: string;
    documentStatus?: string;
    billStatus?: string;
    receiptStatus?: string;
    paymentStatus?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
  }) => Promise<any>;
  issueSupplierCreditNoteApi: (payload: any) => Promise<{success: boolean; creditNote?: any; error?: string}>;
  fetchPurchaseReceiptsApi: (id: string, query?: any) => Promise<any>;
  fetchPurchaseAllocationsApi: (id: string, query?: any) => Promise<any>;
  fetchPurchaseReturnsApi: (id: string, query?: any) => Promise<any>;
  fetchPurchaseCreditNotesApi: (id: string, query?: any) => Promise<any>;
  fetchAuditHistoryApi: (query?: any) => Promise<any>;
  resetDemoData: () => void;
  loginAsLiveCompany: () => Promise<boolean>;

  // Phase 4: Live Sales, Quotations, and Stock Holds
  saveQuotationApi: (q: any, existingId?: string, version?: number) => Promise<{success: boolean; quotation?: any; error?: string}>;
  shareQuotationApi: (id: string, version?: number, idempotencyKey?: string) => Promise<{success: boolean; quotation?: any; error?: string}>;
  cancelQuotationApi: (id: string, version?: number, reason?: string) => Promise<{success: boolean; error?: string}>;
  reopenQuotationApi: (id: string, version?: number, validUntil?: string) => Promise<{success: boolean; error?: string}>;
  convertQuotationApi: (id: string, version?: number, invoiceDate?: string) => Promise<{success: boolean; draft?: any; error?: string}>;
  fetchQuotationsPage: (query?: {page?: number; limit?: number; customerId?: string; status?: string; search?: string; dateFrom?: string; dateTo?: string}) => Promise<PaginationResult<Bill>>;
  fetchQuotationDetailApi: (id: string) => Promise<{quotation: any}>;

  saveInvoiceDraftApi: (inv: any, existingId?: string, version?: number) => Promise<{success: boolean; draft?: any; error?: string}>;
  cancelInvoiceDraftApi: (id: string, version?: number, reason?: string) => Promise<{success: boolean; error?: string}>;
  issueInvoiceApi: (id: string, payload: any) => Promise<{success: boolean; invoice?: any; error?: string}>;
  fetchInvoicesPage: (query?: {page?: number; limit?: number; customerId?: string; status?: string; search?: string; dateFrom?: string; dateTo?: string; hasDue?: boolean}) => Promise<PaginationResult<Bill>>;
  fetchInvoiceDetailApi: (id: string) => Promise<{invoice: any}>;

  fetchReservationsPage: (query?: {page?: number; limit?: number; customerId?: string; productId?: string; status?: string; search?: string; dateFrom?: string; dateTo?: string}) => Promise<PaginationResult<Reservation>>;
  createReservationApi: (payload: any) => Promise<{success: boolean; reservation?: any; error?: string}>;
  releaseReservationApi: (id: string, version?: number, reason?: string) => Promise<{success: boolean; error?: string}>;
  expireReservationsApi: () => Promise<{success: boolean; processed?: number; error?: string}>;

  recordCustomerReceiptApi: (payload: any) => Promise<{success: boolean; receipt?: any; error?: string}>;
  allocateCustomerAdvanceApi: (id: string, payload: any) => Promise<{success: boolean; error?: string}>;
  refundCustomerAdvanceApi: (id: string, payload: any) => Promise<{success: boolean; refund?: any; error?: string}>;
  reverseCustomerReceiptApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  reverseCustomerAllocationApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  reverseCustomerRefundApi: (id: string, reason: string) => Promise<{success: boolean; error?: string}>;
  fetchCustomerReceiptsPage: (query?: any) => Promise<any>;
  fetchCustomerStatementApi: (customerId: string, query?: any) => Promise<any>;
  recordCustomerReturnApi: (payload: any) => Promise<{success: boolean; returnDoc?: any; error?: string}>;
  fetchCustomerReturnsPage: (query?: any) => Promise<any>;
  fetchWarrantiesPage: (query?: any) => Promise<any>;
  claimWarrantyApi: (id: string, payload: any) => Promise<{success: boolean; status?: number; error?: string}>;
  createWarrantyCoverageApi: (payload: any) => Promise<{success: boolean; status?: number; warrantyId?: string; error?: string}>;
  fetchWarrantyDetailApi: (id: string) => Promise<{warranty: any}>;
  fetchEnquiriesPage: (query?: {page?: number; limit?: number; customerId?: string; status?: string; category?: string; search?: string}) => Promise<PaginationResult<Enquiry>>;
  saveEnquiryApi: (payload: any, existingId?: string, version?: number) => Promise<{success: boolean; enquiry?: any; error?: string}>;
  updateInvoiceDueDateApi: (id: string, promisedPaymentDate: string, notes?: string, expectedVersion?: number) => Promise<{success: boolean; error?: string}>;
  updatePurchaseDueDateApi: (id: string, promisedPaymentDate: string, notes?: string, expectedVersion?: number) => Promise<{success: boolean; error?: string}>;
  fetchCustomerProfileApi: (customerId: string, query?: {page?: number; limit?: number}) => Promise<any>;
  createPaymentVoucherApi: (payload: any) => Promise<{success: boolean; voucher?: any; error?: string}>;
  fetchPaymentVouchersPage: (query?: any) => Promise<any>;
};

function emptyLiveState(): State {
  const clean = structuredClone(seed);
  for (const key of Object.keys(clean) as (keyof State)[]) {
    if (Array.isArray(clean[key])) (clean as any)[key] = [];
  }
  clean.defaultTemplateId = '';
  clean.settings = {name: '', phone: '', email: '', address: '', gst: '', state: '', stateCode: '', postalCode: '', bank: '', account: '', ifsc: '', declaration: '', logo: ''};
  return clean;
}

const Context = createContext<Store | null>(null);

export function StoreProvider({children}: {children: ReactNode}) {
  const demoModeEnabled = process.env.NEXT_PUBLIC_ENABLE_DEMO_MODE === 'true';
  const [state, setState] = useState<State>(() => demoModeEnabled ? structuredClone(seed) : emptyLiveState());
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => {
    if (!demoModeEnabled) {
      setClientReady(true);
      return;
    }
    try {
      const saved = localStorage.getItem('print_billing_demo_state_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.purchases)) setState(parsed);
      }
    } catch {}
    setClientReady(true);
  }, [demoModeEnabled]);
  const [role, setRole] = useState('Staff');
  const [toast, setToast] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [businessDataMode, setBusinessDataMode] = useState<'demo-only' | 'live' | 'demo-imported'>('demo-only');
  const [companySession, setCompanySession] = useState<CompanySession | null>(null);
  const [openingStatus, setOpeningStatus] = useState<OpeningStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  function notify(s: string) {
    setToast(s);
    setTimeout(() => setToast(''), 4500);
  }

  function run(fn: (s: State) => State, message: string) {
    if (isLive) {
      notify('This action is unavailable for the live company account.');
      return false;
    }
    try {
      setState(fn(state));
      notify(message);
      return true;
    } catch {
      notify('Action could not be completed.');
      return false;
    }
  }

  const refreshMasterData = useCallback(async () => {
    try {
      setIsLoading(true);
      const meRes = await fetch('/api/auth/me', {cache: 'no-store'});
      if (!meRes.ok) {
        setIsLive(false);
        setState(demoModeEnabled ? structuredClone(seed) : emptyLiveState());
        setBusinessDataMode('demo-only');
        setCompanySession(null);
        setOpeningStatus(null);
        setRole('Staff');
        setIsLoading(false);
        return;
      }
      const meData = await meRes.json();
      setCompanySession(meData);
      setBusinessDataMode(meData.businessDataMode || 'live');
      setIsLive(true);
      setState(emptyLiveState());
      setRole('Staff');

      // These endpoints are independent after authentication. Fetch them in
      // parallel so the shell does not wait for bootstrap before starting the
      // invoice and receipt requests.
      const [bootRes, invRes, recRes] = await Promise.all([
        fetch('/api/master/bootstrap', {cache: 'no-store'}),
        fetch('/api/sales/invoices?limit=50', {cache: 'no-store'}),
        fetch('/api/sales/receipts?limit=50', {cache: 'no-store'}),
      ]);
      if (!bootRes.ok) {
        setIsLoading(false);
        return;
      }
      const boot = await bootRes.json();
      const invData = invRes.ok ? await invRes.json() : {items: []};
      const recData = recRes.ok ? await recRes.json() : {items: []};

      setOpeningStatus(boot.opening || boot.openingStatus || null);

      // Hydrate state with canonical mapped master records from backend
      setState((prev) => ({
        ...prev,
        settings: {
          name: boot.company.name || prev.settings.name,
          phone: boot.company.phone || '',
          email: boot.company.email || '',
          address: boot.company.address || '',
          gst: boot.company.gst || '',
          state: boot.company.state || '',
          stateCode: boot.company.stateCode || '',
          postalCode: boot.company.postalCode || '',
          bank: boot.company.bank || '',
          account: boot.company.account || '',
          ifsc: boot.company.ifsc || '',
          declaration: boot.company.declaration || prev.settings.declaration,
          logo: boot.company.logoFileId ? `/api/files/${boot.company.logoFileId}` : '',
        },
        customers: (boot.firstCustomers || []).map(mapCustomerFromApi),
        suppliers: (boot.firstSuppliers || []).map(mapSupplierFromApi),
        products: (boot.firstProducts || []).map(mapProductFromApi),
        serviceCatalog: (boot.services || []).map(mapServiceFromApi),
        templates: (boot.templates || []).map(mapTemplateFromApi),
        defaultTemplateId: boot.defaultTemplateId || '',
        bills: (invData.items || []).map(mapInvoiceFromApi),
        payments: (recData.items || []).flatMap((r: any) =>
          (r.components || []).map((c: any) => ({
            id: c._id || r._id,
            date: r.date || '',
            direction: 'In' as const,
            account: c.account || 'Cash',
            amount: (c.amountPaise || 0) / 100,
            purpose: 'Customer payment',
            reference: r.receiptNumber || r._id,
            party: r.customerId || '',
            note: c.method || '',
          }))
        ),
        audit: (boot.recentAudit || []).map((a: any) => ({
          id: a._id || a.id,
          action: a.action,
          detail: a.detail,
        })),
      }));

    } catch (err) {
      console.error('Failed to bootstrap master data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [demoModeEnabled]);

  useEffect(() => {
    refreshMasterData();
  }, [refreshMasterData]);

  useEffect(() => {
    if (demoModeEnabled && clientReady && !isLoading && !isLive && typeof window !== 'undefined') {
      try {
        localStorage.setItem('print_billing_demo_state_v1', JSON.stringify(state));
      } catch {}
    }
  }, [state, isLive, clientReady, isLoading, demoModeEnabled]);

  function resetDemoData() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('print_billing_demo_state_v1');
      } catch {}
    }
    setState(structuredClone(seed));
    notify('Demo workspace reset to initial seed data.');
  }

  async function loginAsLiveCompany() {
    // Demo auto-login removed. Use the Company account page to sign in.
    notify('Use the Company account page to sign in to your live account.');
    return false;
  }

  // --- API Mutators for Live Mode ---

  async function saveSettingsApi(f: Partial<State['settings']>, logoFile?: File) {
    if (!isLive) {
      setState((s) => ({...s, settings: {...s.settings, ...f}}));
      notify('Store details updated.');
      return true;
    }
    try {
      let logoFileId = undefined;
      if (logoFile) {
        const upData = await uploadFile(logoFile);
        logoFileId = upData.id || upData._id;
      }

      const payload = {
        name: f.name || '',
        phone: f.phone || '',
        email: f.email || '',
        address: f.address || '',
        gst: f.gst || '',
        state: f.state || '',
        stateCode: f.stateCode || '',
        postalCode: f.postalCode || '',
        bank: f.bank || '',
        account: f.account || '',
        ifsc: f.ifsc || '',
        declaration: f.declaration || '',
        ...(logoFileId ? {logoFileId} : {}),
      };

      const res = await fetch('/api/company/settings', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update settings.');

      await refreshMasterData();
      notify('Company settings saved.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error updating settings.');
      return false;
    }
  }

  async function updateLogoApi(file: File | null) {
    if (!isLive) {
      const logo = file ? URL.createObjectURL(file) : '';
      setState((s) => ({...s, settings: {...s.settings, logo}}));
      notify(file ? 'Logo preview updated.' : 'Logo removed.');
      return true;
    }
    try {
      let logoFileId: string | null = null;
      if (file) {
        const upData = await uploadFile(file);
        logoFileId = upData.id || upData._id;
      }

      const res = await fetch('/api/company/settings', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({logoFileId}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update company logo.');

      await refreshMasterData();
      notify(logoFileId ? 'Company logo saved.' : 'Company logo removed.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error updating company logo.');
      return false;
    }
  }

  async function saveCustomerApi(c: any, id?: string) {
    if (!isLive) {
      const value = {...c, id: id || `CUS-${Date.now()}`};
      setState((s) => ({
        ...s,
        customers: id ? s.customers.map((x) => (x.id === id ? value : x)) : [...s.customers, value],
      }));
      notify('Customer saved.');
      return {success: true};
    }
    try {
      const url = id ? `/api/master/customers/${id}` : '/api/master/customers';
      const method = id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: c.name,
          phone: c.phone || '',
          email: c.email || '',
          address: c.address || '',
          gst: c.gst || '',
          type: c.type || 'Individual',
          creditLimitPaise: c.creditLimit !== undefined && c.creditLimit !== '' ? Math.round(Number(c.creditLimit) * 100) : (c.creditLimitPaise || 0),
          paymentTermsDays: c.paymentTerms !== undefined && c.paymentTerms !== '' ? Number(c.paymentTerms) : (c.paymentTermsDays !== undefined ? c.paymentTermsDays : 30),
          notes: c.notes || '',
          details: c.details || {},
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save customer.');
      await refreshMasterData();
      if (data.warning) {
        notify(data.warning);
      } else {
        notify('Customer saved.');
      }
      return {success: true, warning: data.warning};
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error saving customer.');
      return {success: false};
    }
  }

  async function archiveCustomerApi(id: string) {
    if (!isLive) {
      setState((s) => ({...s, customers: s.customers.filter((x) => x.id !== id)}));
      notify('Customer removed.');
      return true;
    }
    try {
      const res = await fetch(`/api/master/customers/${id}`, {method: 'DELETE'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to archive customer.');
      await refreshMasterData();
      notify('Customer archived.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error archiving customer.');
      return false;
    }
  }

  async function saveSupplierApi(s: any, id?: string) {
    if (!isLive) {
      const value = {...s, id: id || `SUP-${Date.now()}`};
      setState((prev) => ({
        ...prev,
        suppliers: id ? prev.suppliers.map((x) => (x.id === id ? value : x)) : [...prev.suppliers, value],
      }));
      notify('Supplier saved.');
      return {success: true};
    }
    try {
      const url = id ? `/api/master/suppliers/${id}` : '/api/master/suppliers';
      const method = id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: s.name,
          phone: s.phone || '',
          email: s.email || '',
          address: s.address || '',
          gst: s.gst || '',
          paymentTermsDays: s.terms !== undefined && s.terms !== '' ? Number(s.terms) : (s.paymentTermsDays !== undefined ? s.paymentTermsDays : 30),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save supplier.');
      await refreshMasterData();
      if (data.warning) {
        notify(data.warning);
      } else {
        notify('Supplier saved.');
      }
      return {success: true, warning: data.warning};
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error saving supplier.');
      return {success: false};
    }
  }

  async function archiveSupplierApi(id: string) {
    if (!isLive) {
      setState((prev) => ({...prev, suppliers: prev.suppliers.filter((x) => x.id !== id)}));
      notify('Supplier removed.');
      return true;
    }
    try {
      const res = await fetch(`/api/master/suppliers/${id}`, {method: 'DELETE'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to archive supplier.');
      await refreshMasterData();
      notify('Supplier archived.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error archiving supplier.');
      return false;
    }
  }

  async function saveProductApi(p: any, id?: string) {
    if (!isLive) {
      const value = {...p, id: id || `PRD-${Date.now()}`};
      setState((prev) => ({
        ...prev,
        products: id ? prev.products.map((x) => (x.id === id ? value : x)) : [...prev.products, value],
      }));
      notify('Product saved.');
      return true;
    }
    try {
      const url = id ? `/api/master/products/${id}` : '/api/master/products';
      const method = id ? 'PUT' : 'POST';
      const payload = {
        name: p.name,
        description: p.description || '',
        unit: p.unit || 'Piece',
        category: p.category,
        brand: p.brand || '',
        condition: p.condition || 'New',
        model: p.model || '',
        hsn: p.hsn,
        costPaise: Math.round((Number(p.cost) || 0) * 100),
        sellingPricePaise: Math.round((Number(p.price) || 0) * 100),
        priceEntryMode: p.priceEntryMode || 'Inclusive',
        taxBasisPoints: p.tax !== undefined && p.tax !== '' ? Math.round(Number(p.tax) * 100) : 1800,
        low: p.low !== undefined && p.low !== '' ? Number(p.low) : 2,
        warranty: p.warranty !== undefined && p.warranty !== '' ? Number(p.warranty) : 12,
        preferredSupplierId: p.supplier || p.preferredSupplierId || undefined,
        isSerialTracked: !!p.isSerialTracked,
      };

      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save product.');
      await refreshMasterData();
      notify('Product saved.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error saving product.');
      return false;
    }
  }

  async function adjustProductStockApi(id: string, delta: number, serials: string[], reason: string, idempotencyKey?: string) {
    if (!isLive) {
      notify('Demo stock adjustment recorded.');
      return true;
    }
    try {
      const res = await fetch(`/api/master/products/${id}/adjust`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          delta,
          serials,
          reason,
          idempotencyKey: idempotencyKey || `ADJ-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to adjust stock.');
      await refreshMasterData();
      notify('Stock adjustment recorded.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error adjusting stock.');
      return false;
    }
  }

  async function archiveProductApi(id: string) {
    if (!isLive) {
      setState((prev) => ({...prev, products: prev.products.filter((x) => x.id !== id)}));
      notify('Product removed.');
      return true;
    }
    try {
      const res = await fetch(`/api/master/products/${id}`, {method: 'DELETE'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to archive product.');
      await refreshMasterData();
      notify('Product archived.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error archiving product.');
      return false;
    }
  }

  async function saveServiceApi(srv: any, id?: string) {
    if (!isLive) {
      const value = {...srv, id: id || `SRV-${Date.now()}`};
      setState((prev) => ({
        ...prev,
        serviceCatalog: id ? prev.serviceCatalog.map((x) => (x.id === id ? value : x)) : [...prev.serviceCatalog, value],
      }));
      notify('Service saved.');
      return true;
    }
    try {
      const url = id ? `/api/master/services/${id}` : '/api/master/services';
      const method = id ? 'PUT' : 'POST';
      const payload = {
        name: srv.name,
        category: srv.category,
        description: srv.description || '',
        unit: srv.unit || 'Job',
        ratePaise: Math.round((Number(srv.rate) || 0) * 100),
        taxBasisPoints: srv.tax !== undefined && srv.tax !== '' ? Math.round(Number(srv.tax) * 100) : 1800,
        sac: srv.sac || '998713',
        warranty: srv.warranty !== undefined && srv.warranty !== '' ? Number(srv.warranty) : 0,
        active: srv.active !== false,
      };

      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save service.');
      await refreshMasterData();
      notify('Service saved.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error saving service.');
      return false;
    }
  }

  async function archiveServiceApi(id: string) {
    if (!isLive) {
      setState((prev) => ({...prev, serviceCatalog: prev.serviceCatalog.filter((x) => x.id !== id)}));
      notify('Service removed.');
      return true;
    }
    try {
      const res = await fetch(`/api/master/services/${id}`, {method: 'DELETE'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to archive service.');
      await refreshMasterData();
      notify('Service archived.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error archiving service.');
      return false;
    }
  }

  async function saveTemplateApi(t: any, id?: string) {
    if (!isLive) {
      const value = {...t, id: id || `TPL-${Date.now()}`};
      setState((prev) => ({
        ...prev,
        templates: id ? prev.templates.map((x) => (x.id === id ? value : x)) : [...prev.templates, value],
      }));
      notify('Template saved.');
      return true;
    }
    try {
      const url = id ? `/api/master/templates/${id}` : '/api/master/templates';
      const method = id ? 'PUT' : 'POST';
      const current = id ? state.templates.find((tpl: any) => tpl.id === id) : null;
      const expectedRevision = t.expectedRevision ?? (current as any)?.currentRevision ?? (current as any)?.revision;
      if (id && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
        throw new Error('Reload this template before editing: its saved revision is missing.');
      const payload = {
        name: t.name,
        title: t.title ?? '',
        paper: t.paper ?? 'A4',
        orientation: t.orientation ?? 'portrait',
        fontSize: t.fontSize ?? 11,
        accent: t.accent ?? '#373737',
        borders: !!t.borders,
        striped: !!t.striped,
        logoPosition: t.logoPosition ?? 'left',
        fields: t.fields ?? {},
        columns: t.columns ?? [],
        footer: t.footer ?? 'This is a computer generated invoice.',
        isDefault: !!t.isDefault,
        ...(id ? {expectedRevision} : {}),
      };
      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save template.');
      await refreshMasterData();
      notify('Template saved.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error saving template.');
      return false;
    }
  }

  async function setDefaultTemplateApi(id: string) {
    if (!isLive) {
      setState((prev) => ({...prev, defaultTemplateId: id}));
      notify('Default template updated.');
      return true;
    }
    try {
      const res = await fetch(`/api/master/templates/${id}/default`, {method: 'POST'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set default template.');
      await refreshMasterData();
      notify('Default template updated.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error updating default template.');
      return false;
    }
  }

  async function archiveTemplateApi(id: string) {
    if (!isLive) {
      setState((prev) => ({...prev, templates: prev.templates.filter((x) => x.id !== id)}));
      notify('Template removed.');
      return true;
    }
    try {
      const res = await fetch(`/api/master/templates/${id}`, {method: 'DELETE'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to archive template.');
      await refreshMasterData();
      notify('Template archived.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error archiving template.');
      return false;
    }
  }

  async function restoreCustomerApi(id: string) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/master/customers/${id}/restore`, {method: 'POST'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore customer.');
      await refreshMasterData();
      notify('Customer restored to active.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error restoring customer.');
      return false;
    }
  }

  async function restoreSupplierApi(id: string) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/master/suppliers/${id}/restore`, {method: 'POST'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore supplier.');
      await refreshMasterData();
      notify('Supplier restored to active.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error restoring supplier.');
      return false;
    }
  }

  async function restoreProductApi(id: string) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/master/products/${id}/restore`, {method: 'POST'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore product.');
      await refreshMasterData();
      notify('Product restored to active.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error restoring product.');
      return false;
    }
  }

  async function restoreServiceApi(id: string) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/master/services/${id}/restore`, {method: 'POST'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore service.');
      await refreshMasterData();
      notify('Service restored to active.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error restoring service.');
      return false;
    }
  }

  async function restoreTemplateApi(id: string) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/master/templates/${id}/restore`, {method: 'POST'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore template.');
      await refreshMasterData();
      notify('Invoice template restored to active.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error restoring template.');
      return false;
    }
  }

  async function fetchOpeningDraftApi() {
    try {
      const res = await fetch('/api/master/opening');
      const data = await res.json();
      if (res.ok) {
        return data.opening || data.draft || data;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function saveOpeningDraftApi(draft: any) {
    try {
      const res = await fetch('/api/master/opening/draft', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save opening draft.');
      await refreshMasterData();
      notify('Opening balance draft saved.');
      return {success: true, draftVersion: data.draftVersion ?? data.opening?.draftVersion};
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error saving draft.');
      return {success: false};
    }
  }

  async function finalizeOpeningApi(options?: {expectedDraftVersion?: number}) {
    try {
      const res = await fetch('/api/master/opening/finalize', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(options || {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to finalize opening setup.');
      await refreshMasterData();
      notify('Opening balances finalized and posted to company ledger.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error finalizing opening setup.');
      return false;
    }
  }

  async function importDemoMasterDataApi() {
    try {
      const res = await fetch('/api/master/opening/import-demo', {method: 'POST'});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to import demo master data.');
      await refreshMasterData();
      notify('Sample master data imported into your company account. Opening draft ready for review.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error importing sample data.');
      return false;
    }
  }

  // --- Server-Side Pagination Query Methods ---

  async function fetchCustomersPage(query: {page?: number; limit?: number; q?: string; status?: string; type?: string} = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.q) p.set('q', query.q);
    if (query.status) p.set('status', query.status);
    if (query.type) p.set('type', query.type);
    const res = await fetch(`/api/master/customers?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load customers');
    return {
      records: (data.records || []).map(mapCustomerFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  async function fetchSuppliersPage(query: {page?: number; limit?: number; q?: string; status?: string} = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.q) p.set('q', query.q);
    if (query.status) p.set('status', query.status);
    const res = await fetch(`/api/master/suppliers?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load suppliers');
    return {
      records: (data.records || []).map(mapSupplierFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  async function fetchProductsPage(query: {page?: number; limit?: number; q?: string; category?: string; status?: string} = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.q) p.set('q', query.q);
    if (query.category) p.set('category', query.category);
    if (query.status) p.set('status', query.status);
    const res = await fetch(`/api/master/products?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load products');
    return {
      records: (data.records || []).map(mapProductFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  // --- Phase 3 Live Purchases & Supplier Settlement Methods ---

  function purchasePayloadFromUi(p: any, postImmediately = false) {
    return {
      supplierId: p.supplierId,
      orderDate: p.orderDate || p.date,
      dueDate: p.dueDate || p.due || undefined,
      inclusive: !!p.inclusive,
      taxMode: p.taxMode,
      placeOfSupply: p.placeOfSupply,
      notes: p.notes || '',
      attachmentFileId: p.attachmentFileId || undefined,
      supplierInvoiceNumber: p.supplierInvoiceNumber || p.reference || undefined,
      supplierInvoiceDate: p.supplierInvoiceDate || undefined,
      postImmediately,
      lines: (p.lines || []).map((l: any) => ({
        clientLineKey: l.clientLineKey,
        lineId: l.lineId,
        lineType: l.lineType || 'Product',
        productId: (l.lineType || 'Product') === 'Product' ? l.productId : undefined,
        description: (l.lineType || 'Product') === 'Charge' ? (l.description || l.name) : undefined,
        sac: (l.lineType || 'Product') === 'Charge' ? (l.sac || l.hsn || '') : undefined,
        quantityOrdered: (l.lineType || 'Product') === 'Charge' ? 1 : (Number(l.quantityOrdered ?? l.qty) || 1),
        unitCostPaise: Math.round(Number(l.unitCostPaise ?? ((l.rate || 0) * 100))),
        taxBasisPoints: Math.round(Number(l.taxBasisPoints ?? ((l.tax || 0) * 100))),
        discountType: l.discountType || 'Percentage',
        discountValue: Math.round(Number(l.discountValue ?? ((l.discount || 0) * 100))),
      })),
    };
  }

  async function savePurchaseApi(p: any, postImmediately?: boolean, existingId?: string, version?: number) {
    if (!isLive) {
      notify('Demo purchase saved.');
      return {success: true};
    }
    try {
      const isExisting = !!(existingId || p.existingId);
      const targetId = existingId || p.existingId || p.id;
      const targetVersion = version ?? p.version;
      const payload = purchasePayloadFromUi(p, !!postImmediately);

      let res: Response;
      if (isExisting && targetId) {
        res = await fetch(`/api/purchases/${targetId}`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            version: targetVersion,
            supplierId: payload.supplierId,
            orderDate: payload.orderDate,
            dueDate: payload.dueDate,
            supplierInvoiceNumber: payload.supplierInvoiceNumber,
            supplierInvoiceDate: payload.supplierInvoiceDate,
            inclusive: payload.inclusive,
            taxMode: payload.taxMode,
            placeOfSupply: payload.placeOfSupply,
            notes: payload.notes,
            attachmentFileId: payload.attachmentFileId,
            lines: payload.lines,
          }),
        });
      } else {
        res = await fetch('/api/purchases', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save purchase.');
      await refreshMasterData();
      notify('Purchase saved successfully.');
      return {success: true, purchase: data.purchase || data};
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Error saving purchase.';
      notify(error);
      return {success: false, error};
    }
  }

  async function confirmPurchaseOrderApi(id: string, expectedVersion?: number) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/${id}/confirm`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expectedVersion,
          idempotencyKey: `confirm-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to confirm purchase order.');
      await refreshMasterData();
      notify('Purchase order confirmed.');
      return {success: true, purchase: data};
    } catch (e: any) {
      notify(e.message || 'Error confirming purchase order.');
      return {success: false, error: e.message};
    }
  }

  async function postPurchaseBillApi(id: string, invoiceNumber: string, invoiceDate: string, expectedVersion?: number) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/${id}/post`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          supplierInvoiceNumber: invoiceNumber,
          supplierInvoiceDate: invoiceDate,
          expectedVersion,
          idempotencyKey: `post-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to post bill.');
      await refreshMasterData();
      notify('Supplier bill posted.');
      return {success: true, purchase: data};
    } catch (e: any) {
      notify(e.message || 'Error posting bill.');
      return {success: false, error: e.message};
    }
  }

  async function receivePurchaseStockApi(id: string, lines: any[], options?: {idempotencyKey: string; receiptDate: string}) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/purchases/${id}/receive`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          receiptDate: options?.receiptDate ?? new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date()),
          lines,
          idempotencyKey: options?.idempotencyKey ?? `receipt-${id}-${crypto.randomUUID()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to receive stock.');
      await refreshMasterData();
      notify('Stock received into inventory.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error receiving stock.');
      return false;
    }
  }

  async function recordReceiveShortcutApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const body = {
        purchase: purchasePayloadFromUi({
          ...payload.purchase,
          supplierInvoiceNumber: payload.supplierInvoiceNumber || payload.purchase?.supplierInvoiceNumber || payload.purchase?.reference,
          supplierInvoiceDate: payload.supplierInvoiceDate || payload.purchase?.supplierInvoiceDate,
        }, true),
        receipt: {
          receiptDate: payload.receiptDate || payload.purchase?.date,
          lines: payload.receiptLines || payload.receipt?.lines || [],
          notes: payload.receiptNotes || payload.receipt?.notes || '',
        },
        idempotencyKey: payload.idempotencyKey,
      };
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record and receive purchase.');
      await refreshMasterData();
      notify('Purchase recorded and stock received.');
      return {success: true, purchase: data.purchase, receipt: data.receipt};
    } catch (e: any) {
      notify(e.message || 'Error recording purchase.');
      return {success: false, error: e.message};
    }
  }

  async function recordReceiveAndPayShortcutApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const body = {
        purchase: purchasePayloadFromUi({
          ...payload.purchase,
          supplierInvoiceNumber: payload.supplierInvoiceNumber || payload.purchase?.supplierInvoiceNumber || payload.purchase?.reference,
          supplierInvoiceDate: payload.supplierInvoiceDate || payload.purchase?.supplierInvoiceDate,
        }, true),
        receipt: {
          receiptDate: payload.receiptDate || payload.purchase?.date,
          lines: payload.receiptLines || payload.receipt?.lines || [],
          notes: payload.receiptNotes || payload.receipt?.notes || '',
        },
        payment: payload.payment,
        idempotencyKey: payload.idempotencyKey,
      };
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record, receive, and pay purchase.');
      await refreshMasterData();
      notify('Purchase recorded, received, and paid.');
      return {success: true, purchase: data.purchase, receipt: data.receipt, payment: data.payment};
    } catch (e: any) {
      notify(e.message || 'Error recording purchase and payment.');
      return {success: false, error: e.message};
    }
  }

  async function recordSupplierPaymentApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch('/api/purchases/payments', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record supplier payment.');
      await refreshMasterData();
      notify('Supplier payment recorded.');
      return {success: true, payment: data};
    } catch (e: any) {
      notify(e.message || 'Error recording supplier payment.');
      return {success: false, error: e.message};
    }
  }

  async function closePurchaseRemainderApi(id: string, expectedVersion?: number, reason?: string) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/purchases/${id}/close-remainder`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expectedVersion,
          reason: reason || 'Closed remainder',
          idempotencyKey: `close-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to close remainder.');
      await refreshMasterData();
      notify('Remainder closed.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error closing remainder.');
      return false;
    }
  }

  async function cancelPurchaseApi(id: string, expectedVersion?: number) {
    if (!isLive) return true;
    try {
      const res = await fetch(`/api/purchases/${id}/cancel`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expectedVersion,
          idempotencyKey: `cancel-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel purchase.');
      await refreshMasterData();
      notify('Purchase cancelled.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Error cancelling purchase.');
      return false;
    }
  }

  async function reversePurchaseReceiptApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/receipts/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-rcp-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse receipt.');
      await refreshMasterData();
      notify('Purchase receipt reversed.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error reversing receipt.');
      return {success: false, error: e.message};
    }
  }

  async function reverseSupplierReturnApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/returns/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-ret-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse supplier return.');
      await refreshMasterData();
      notify('Supplier return reversed.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error reversing return.');
      return {success: false, error: e.message};
    }
  }

  async function reverseSupplierPaymentApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/payments/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-pay-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse payment.');
      await refreshMasterData();
      notify('Supplier payment reversed.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error reversing payment.');
      return {success: false, error: e.message};
    }
  }

  async function reverseSupplierAllocationApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/allocations/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-alloc-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse allocation.');
      await refreshMasterData();
      notify('Supplier allocation reversed.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error reversing allocation.');
      return {success: false, error: e.message};
    }
  }

  async function reverseSupplierCreditNoteApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/credit-notes/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-cn-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse credit note.');
      await refreshMasterData();
      notify('Supplier credit note reversed.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error reversing credit note.');
      return {success: false, error: e.message};
    }
  }

  async function reverseSupplierRefundApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/refunds/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-rfd-${id}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse refund.');
      await refreshMasterData();
      notify('Supplier refund reversed.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error reversing refund.');
      return {success: false, error: e.message};
    }
  }

  async function quarantineStockApi(payload: {lotId: string; quantity: number; serials?: string[]; reason: string}) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch('/api/purchases/stock/quarantine', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: `quar-${payload.lotId}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to quarantine stock.');
      await refreshMasterData();
      notify('Stock moved to quarantine.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error quarantining stock.');
      return {success: false, error: e.message};
    }
  }

  async function restoreStockApi(payload: {lotId: string; quantity: number; serials?: string[]; reason: string}) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch('/api/purchases/stock/restore', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: `rest-${payload.lotId}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore stock.');
      await refreshMasterData();
      notify('Stock restored to sellable inventory.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error restoring stock.');
      return {success: false, error: e.message};
    }
  }

  async function recordSupplierReturnApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch('/api/purchases/returns', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `ret-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record supplier return.');
      await refreshMasterData();
      notify('Supplier return recorded.');
      return {success: true, returnDoc: data};
    } catch (e: any) {
      notify(e.message || 'Error recording return.');
      return {success: false, error: e.message};
    }
  }

  async function acceptReturnCreditNoteApi(returnId: string, payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/returns/${returnId}/accept`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `acc-${returnId}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to accept credit note.');
      await refreshMasterData();
      notify('Return credit note accepted.');
      return {success: true, creditNote: data};
    } catch (e: any) {
      notify(e.message || 'Error accepting credit note.');
      return {success: false, error: e.message};
    }
  }

  async function recordSupplierRefundApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch('/api/purchases/refunds', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `rfd-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record refund.');
      await refreshMasterData();
      notify('Supplier refund recorded.');
      return {success: true, refund: data};
    } catch (e: any) {
      notify(e.message || 'Error recording refund.');
      return {success: false, error: e.message};
    }
  }

  async function allocateSupplierAdvanceApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const advanceId = payload.advanceId;
      const body = payload.allocations
        ? payload
        : {
            allocations: [{
              targetType: payload.targetType || 'PurchaseLine',
              targetId: payload.targetId || payload.purchaseId,
              purchaseLineId: payload.purchaseLineId,
              amountPaise: payload.amountPaise,
            }],
            effectiveDate: payload.effectiveDate,
            idempotencyKey: payload.idempotencyKey || `alloc-${advanceId}-${Date.now()}`,
          };
      const res = await fetch(`/api/purchases/advances/${advanceId}/allocate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to allocate advance.');
      await refreshMasterData();
      notify('Supplier advance allocated.');
      return {success: true};
    } catch (e: any) {
      notify(e.message || 'Error allocating advance.');
      return {success: false, error: e.message};
    }
  }

  async function fetchPurchaseDetailApi(id: string) {
    const res = await fetch(`/api/purchases/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load purchase details.');
    return data;
  }

  async function fetchSupplierStatementApi(supplierId: string, params: any = {}) {
    const p = new URLSearchParams();
    if (params.page) p.set('page', String(params.page));
    if (params.limit) p.set('limit', String(params.limit));
    if (params.dateFrom) p.set('dateFrom', params.dateFrom);
    if (params.dateTo) p.set('dateTo', params.dateTo);
    if (params.asOfDate) p.set('asOfDate', params.asOfDate);
    const res = await fetch(`/api/suppliers/${supplierId}/statement?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load statement.');
    return {...data, entries: data.entries || data.items || []};
  }

  async function fetchSupplierPayablesApi(supplierId: string, query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    const res = await fetch(`/api/suppliers/${supplierId}/payables?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load payables.');
    return data;
  }

  async function fetchSupplierAdvancesApi(supplierId: string, query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    const res = await fetch(`/api/suppliers/${supplierId}/advances?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load advances.');
    return data;
  }

  async function fetchPurchasesPage(query: {
    page?: number;
    limit?: number;
    hasDue?: boolean;
    supplierId?: string;
    productId?: string;
    status?: string;
    documentStatus?: string;
    billStatus?: string;
    receiptStatus?: string;
    paymentStatus?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
  } = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.hasDue) p.set('hasDue', 'true');
    if (query.supplierId) p.set('supplierId', query.supplierId);
    if (query.productId) p.set('productId', query.productId);
    if (query.status) p.set('status', query.status);
    if (query.documentStatus) p.set('documentStatus', query.documentStatus);
    if (query.billStatus) p.set('billStatus', query.billStatus);
    if (query.receiptStatus) p.set('receiptStatus', query.receiptStatus);
    if (query.paymentStatus) p.set('paymentStatus', query.paymentStatus);
    if (query.dateFrom) p.set('dateFrom', query.dateFrom);
    if (query.dateTo) p.set('dateTo', query.dateTo);
    if (query.search) p.set('q', query.search);
    const res = await fetch(`/api/purchases?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load purchases.');
    return {
      records: (data.records || []).map(mapPurchaseFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  async function issueSupplierCreditNoteApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch('/api/purchases/credit-notes', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `cn-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to issue credit note.');
      await refreshMasterData();
      notify('Credit note issued successfully.');
      return {success: true, creditNote: data};
    } catch (e: any) {
      notify(e.message || 'Error issuing credit note.');
      return {success: false, error: e.message};
    }
  }

  async function fetchPurchaseReceiptsApi(id: string, query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    const res = await fetch(`/api/purchases/${id}/receipts?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load receipts.');
    return data;
  }

  async function fetchPurchaseAllocationsApi(id: string, query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    const res = await fetch(`/api/purchases/${id}/allocations?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load allocations.');
    return data;
  }

  async function fetchPurchaseReturnsApi(id: string, query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    const res = await fetch(`/api/purchases/${id}/returns?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load returns.');
    return data;
  }

  async function fetchPurchaseCreditNotesApi(id: string, query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    const res = await fetch(`/api/purchases/${id}/credit-notes-list?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load credit notes.');
    return data;
  }

  async function fetchAuditHistoryApi(query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.entityId) p.set('entityId', query.entityId);
    if (query.entityType) p.set('entityType', query.entityType);
    const res = await fetch(`/api/master/audit?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load audit history.');
    return data;
  }

  // Phase 4: Sales, Quotations & Stock Holds Live API methods
  async function saveQuotationApi(payload: any, existingId?: string, version?: number) {
    if (!isLive) return {success: true, quotation: payload};
    try {
      const isEdit = !!existingId;
      const url = isEdit ? `/api/sales/quotations/${existingId}` : '/api/sales/quotations';
      const method = isEdit ? 'PUT' : 'POST';
      const body = isEdit
        ? {expectedVersion: version ?? 1, quotation: payload}
        : payload;
      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save quotation.');
      return {success: true, quotation: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function cancelQuotationApi(id: string, version: number = 1, reason: string = 'Cancelled by user') {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/quotations/${id}`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expectedVersion: version,
          reason,
          idempotencyKey: `quote-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel quotation.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function shareQuotationApi(id: string, version: number = 1, idempotencyKey?: string) {
    if (!isLive) {
      setState((s) => ({...s, bills: s.bills.map((b) => b.id === id ? {...b, status: 'Shared', version: (b.version || version) + 1} : b)}));
      return {success: true};
    }
    try {
      const res = await fetch(`/api/sales/quotations/${id}/share`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expectedVersion: version,
          channel: 'Manual',
          idempotencyKey: idempotencyKey || `quote-share-${id}-${version}-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to mark quotation as shared.');
      return {success: true, quotation: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function reopenQuotationApi(id: string, version: number = 1, validUntil?: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/quotations/${id}/reopen`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expectedVersion: version,
          validUntil,
          idempotencyKey: `quote-reopen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reopen quotation.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function convertQuotationApi(id: string, version: number = 1, invoiceDate?: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/quotations/${id}/convert`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          quotationId: id,
          expectedVersion: version,
          invoiceDate: invoiceDate || TODAY,
          idempotencyKey: `quote-convert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to convert quotation.');
      return {success: true, draft: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function fetchQuotationsPage(query: {
    page?: number;
    limit?: number;
    customerId?: string;
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  } = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.customerId) p.set('customerId', query.customerId);
    if (query.status && query.status !== 'All') p.set('status', query.status === 'Shared' ? 'Sent' : query.status);
    if (query.search) p.set('q', query.search);
    if (query.dateFrom) p.set('dateFrom', query.dateFrom);
    if (query.dateTo) p.set('dateTo', query.dateTo);
    const res = await fetch(`/api/sales/quotations?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load quotations.');
    return {
      records: (data.items || []).map(mapQuotationFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  async function fetchQuotationDetailApi(id: string) {
    const res = await fetch(`/api/sales/quotations/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load quotation.');
    return data;
  }

  async function saveInvoiceDraftApi(payload: any, existingId?: string, version?: number) {
    if (!isLive) return {success: true, draft: payload};
    try {
      const isEdit = !!existingId;
      const url = isEdit ? `/api/sales/invoices/${existingId}` : '/api/sales/invoices';
      const method = isEdit ? 'PUT' : 'POST';
      const body = isEdit
        ? {expectedVersion: version ?? 1, draft: payload}
        : payload;
      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save invoice draft.');
      return {success: true, draft: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function cancelInvoiceDraftApi(id: string, version: number = 1, reason: string = 'Cancelled by user') {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/invoices/${id}`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expectedVersion: version,
          reason,
          idempotencyKey: `inv-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel invoice draft.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function issueInvoiceApi(id: string, payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/invoices/${id}/issue`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          draftId: id,
          idempotencyKey: payload.idempotencyKey || `inv-issue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to issue invoice.');
      return {success: true, invoice: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function fetchInvoicesPage(query: {
    page?: number;
    limit?: number;
    customerId?: string;
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    hasDue?: boolean;
  } = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.customerId) p.set('customerId', query.customerId);
    if (query.status && query.status !== 'All') p.set('status', query.status);
    if (query.search) p.set('q', query.search);
    if (query.dateFrom) p.set('dateFrom', query.dateFrom);
    if (query.dateTo) p.set('dateTo', query.dateTo);
    if (query.hasDue) p.set('hasDue', 'true');
    const res = await fetch(`/api/sales/invoices?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load invoices.');
    return {
      records: (data.items || []).map(mapInvoiceFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  async function fetchInvoiceDetailApi(id: string) {
    const res = await fetch(`/api/sales/invoices/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load invoice.');
    return data;
  }

  async function fetchReservationsPage(query: {
    page?: number;
    limit?: number;
    customerId?: string;
    productId?: string;
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  } = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.customerId) p.set('customerId', query.customerId);
    if (query.productId) p.set('productId', query.productId);
    if (query.status && query.status !== 'All') p.set('status', query.status);
    if (query.search) p.set('q', query.search);
    if (query.dateFrom) p.set('dateFrom', query.dateFrom);
    if (query.dateTo) p.set('dateTo', query.dateTo);
    const res = await fetch(`/api/sales/reservations?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load reservations.');
    return {
      records: (data.items || []).map(mapReservationFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  async function createReservationApi(payload: any) {
    if (!isLive) return {success: true, reservation: payload};
    try {
      const res = await fetch('/api/sales/reservations', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `res-create-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create reservation.');
      return {success: true, reservation: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function releaseReservationApi(id: string, version: number = 1, reason: string = 'Released by user') {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/reservations/${id}/release`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reservationId: id,
          expectedVersion: version,
          reason,
          idempotencyKey: `res-release-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to release reservation.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function expireReservationsApi() {
    if (!isLive) return {success: true, processed: 0};
    try {
      const res = await fetch('/api/sales/reservations/expire', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to process expired reservations.');
      return {success: true, processed: data.processed ?? 0};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function recordCustomerReceiptApi(payload: any) {
    if (!isLive) return {success: true, receipt: payload};
    try {
      const res = await fetch('/api/sales/receipts', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `cust-rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record customer receipt.');
      return {success: true, receipt: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function allocateCustomerAdvanceApi(id: string, payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/advances/${id}/allocate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `cust-adv-alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to allocate customer advance.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function refundCustomerAdvanceApi(id: string, payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/advances/${id}/refund`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `cust-adv-rfnd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to refund customer advance.');
      return {success: true, refund: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function reverseCustomerReceiptApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/receipts/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse receipt.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function reverseCustomerAllocationApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/allocations/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-alloc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse allocation.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function reverseCustomerRefundApi(id: string, reason: string) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/refunds/${id}/reverse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          reason,
          idempotencyKey: `rev-rfnd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reverse refund.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function fetchCustomerReceiptsPage(query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.customerId) p.set('customerId', query.customerId);
    if (query.search) p.set('search', query.search);
    if (query.dateFrom) p.set('dateFrom', query.dateFrom);
    if (query.dateTo) p.set('dateTo', query.dateTo);
    const res = await fetch(`/api/sales/receipts?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load receipts.');
    return data;
  }

  async function createPaymentVoucherApi(payload: any) {
    if (!isLive) {
      const voucher = {
        _id: `demo-pv-${Date.now()}`,
        voucherNumber: `PV-DEMO-${Date.now().toString().slice(-4)}`,
        date: payload.date,
        payeeName: payload.payeeName,
        amountPaise: payload.amountPaise,
        account: payload.account,
        method: payload.method,
        purpose: payload.purpose,
        reference: payload.reference || '',
        notes: payload.notes || '',
        createdAt: new Date().toISOString(),
      };
      notify('Payment voucher recorded.');
      return {success: true, voucher};
    }
    try {
      const res = await fetch('/api/payments/vouchers', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record payment voucher.');
      notify('Payment voucher recorded.');
      return {success: true, voucher: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function fetchPaymentVouchersPage(query: any = {}) {
    if (!isLive) {
      return {items: [], total: 0, page: 1, limit: 25, totalPages: 1, balances: {Cash: 5000000, Bank: 10000000}};
    }
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.search) p.set('search', query.search);
    if (query.dateFrom) p.set('dateFrom', query.dateFrom);
    if (query.dateTo) p.set('dateTo', query.dateTo);
    const res = await fetch(`/api/payments/vouchers?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load payment vouchers.');
    return data;
  }


  async function fetchCustomerStatementApi(customerId: string, query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.fromDate) p.set('fromDate', query.fromDate);
    if (query.toDate) p.set('toDate', query.toDate);
    const res = await fetch(`/api/sales/customers/${customerId}/statement?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load customer statement.');
    return data;
  }

  async function recordCustomerReturnApi(payload: any) {
    if (!isLive) return {success: true, returnDoc: payload};
    try {
      const res = await fetch('/api/sales/returns', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `cust-ret-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record return.');
      return {success: true, returnDoc: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function fetchCustomerReturnsPage(query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.customerId) p.set('customerId', query.customerId);
    if (query.invoiceId) p.set('invoiceId', query.invoiceId);
    if (query.dateFrom) p.set('dateFrom', query.dateFrom);
    if (query.dateTo) p.set('dateTo', query.dateTo);
    const res = await fetch(`/api/sales/returns?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load returns.');
    return data;
  }

  async function fetchWarrantiesPage(query: any = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.customerId) p.set('customerId', query.customerId);
    if (query.productId) p.set('productId', query.productId);
    if (query.serial) p.set('serial', query.serial);
    if (query.status) p.set('status', query.status);
    if (query.search) p.set('search', query.search);
    const res = await fetch(`/api/sales/warranties?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load warranties.');
    return data;
  }

  async function claimWarrantyApi(id: string, payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/warranties/${id}/claim`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `wcl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) return {success: false, status: res.status, error: data.error || 'Failed to claim warranty.'};
      await refreshMasterData();
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function createWarrantyCoverageApi(payload: any) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch('/api/sales/warranties', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...payload,
          idempotencyKey: payload.idempotencyKey || `wcov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) return {success: false, status: res.status, error: data.error || 'Failed to create warranty coverage.'};
      await refreshMasterData();
      return {success: true, warrantyId: data.warrantyId};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function fetchWarrantyDetailApi(id: string) {
    const res = await fetch(`/api/sales/warranties/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load warranty.');
    return data;
  }

  async function fetchEnquiriesPage(query: {
    page?: number;
    limit?: number;
    customerId?: string;
    status?: string;
    category?: string;
    search?: string;
  } = {}) {
    const p = new URLSearchParams();
    if (query.page) p.set('page', String(query.page));
    if (query.limit) p.set('limit', String(query.limit));
    if (query.customerId) p.set('customerId', query.customerId);
    if (query.status && query.status !== 'All') p.set('status', query.status);
    if (query.category && query.category !== 'All') p.set('category', query.category);
    if (query.search) p.set('search', query.search);
    const res = await fetch(`/api/enquiries?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load enquiries.');
    return {
      records: (data.records || []).map(mapEnquiryFromApi),
      total: data.total || 0,
      page: data.page || 1,
      totalPages: data.totalPages || 1,
    };
  }

  async function saveEnquiryApi(payload: any, existingId?: string, version?: number) {
    if (!isLive) return {success: true, enquiry: payload};
    try {
      const isEdit = !!existingId;
      const url = isEdit ? `/api/enquiries/${existingId}` : '/api/enquiries';
      const method = isEdit ? 'PATCH' : 'POST';
      const body = isEdit
        ? {expectedVersion: version ?? 1, ...payload}
        : {
            ...payload,
            idempotencyKey: payload.idempotencyKey || `enq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          };
      const res = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save enquiry.');
      return {success: true, enquiry: data};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function updateInvoiceDueDateApi(id: string, promisedPaymentDate: string, notes?: string, expectedVersion?: number) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/sales/invoices/${id}/due-date`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          promisedPaymentDate,
          notes,
          expectedVersion,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update promised payment date.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function updatePurchaseDueDateApi(id: string, promisedPaymentDate: string, notes?: string, expectedVersion?: number) {
    if (!isLive) return {success: true};
    try {
      const res = await fetch(`/api/purchases/${id}/due-date`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          promisedPaymentDate,
          notes,
          expectedVersion,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update supplier promised payment date.');
      return {success: true};
    } catch (err: any) {
      return {success: false, error: err.message};
    }
  }

  async function fetchCustomerProfileApi(customerId: string, query?: {page?: number; limit?: number}) {
    const p = new URLSearchParams();
    if (query?.page) p.set('page', String(query.page));
    if (query?.limit) p.set('limit', String(query.limit));
    const res = await fetch(`/api/sales/customers/${customerId}/profile?${p.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load customer profile.');
    return data;
  }

  return (
    <Context.Provider
      value={{
        state,
        setState,
        role,
        setRole,
        notify,
        run,
        isLive,
        businessDataMode,
        companySession,
        openingStatus,
        isLoading,
        refreshMasterData,
        resetDemoData,
        loginAsLiveCompany,
        saveSettingsApi,
        updateLogoApi,
        saveCustomerApi,
        archiveCustomerApi,
        restoreCustomerApi,
        saveSupplierApi,
        archiveSupplierApi,
        restoreSupplierApi,
        saveProductApi,
        adjustProductStockApi,
        archiveProductApi,
        restoreProductApi,
        saveServiceApi,
        archiveServiceApi,
        restoreServiceApi,
        saveTemplateApi,
        setDefaultTemplateApi,
        archiveTemplateApi,
        restoreTemplateApi,
        fetchOpeningDraftApi,
        saveOpeningDraftApi,
        finalizeOpeningApi,
        importDemoMasterDataApi,
        fetchCustomersPage,
        fetchSuppliersPage,
        fetchProductsPage,
        savePurchaseApi,
        confirmPurchaseOrderApi,
        postPurchaseBillApi,
        receivePurchaseStockApi,
        recordReceiveShortcutApi,
        recordReceiveAndPayShortcutApi,
        recordSupplierPaymentApi,
        closePurchaseRemainderApi,
        cancelPurchaseApi,
        reversePurchaseReceiptApi,
        reverseSupplierReturnApi,
        reverseSupplierPaymentApi,
        reverseSupplierAllocationApi,
        reverseSupplierCreditNoteApi,
        reverseSupplierRefundApi,
        quarantineStockApi,
        restoreStockApi,
        recordSupplierReturnApi,
        acceptReturnCreditNoteApi,
        recordSupplierRefundApi,
        allocateSupplierAdvanceApi,
        issueSupplierCreditNoteApi,
        fetchPurchaseDetailApi,
        fetchPurchaseReceiptsApi,
        fetchPurchaseAllocationsApi,
        fetchPurchaseReturnsApi,
        fetchPurchaseCreditNotesApi,
        fetchAuditHistoryApi,
        fetchSupplierStatementApi,
        fetchSupplierPayablesApi,
        fetchSupplierAdvancesApi,
        fetchPurchasesPage,
        saveQuotationApi,
        shareQuotationApi,
        cancelQuotationApi,
        reopenQuotationApi,
        convertQuotationApi,
        fetchQuotationsPage,
        fetchQuotationDetailApi,
        saveInvoiceDraftApi,
        cancelInvoiceDraftApi,
        issueInvoiceApi,
        fetchInvoicesPage,
        fetchInvoiceDetailApi,
        fetchReservationsPage,
        createReservationApi,
        releaseReservationApi,
        expireReservationsApi,
        recordCustomerReceiptApi,
        allocateCustomerAdvanceApi,
        refundCustomerAdvanceApi,
        reverseCustomerReceiptApi,
        reverseCustomerAllocationApi,
        reverseCustomerRefundApi,
        fetchCustomerReceiptsPage,
        fetchCustomerStatementApi,
        recordCustomerReturnApi,
        fetchCustomerReturnsPage,
        fetchWarrantiesPage,
        claimWarrantyApi,
        createWarrantyCoverageApi,
        fetchWarrantyDetailApi,
        fetchEnquiriesPage,
        saveEnquiryApi,
        updateInvoiceDueDateApi,
        updatePurchaseDueDateApi,
        fetchCustomerProfileApi,
        createPaymentVoucherApi,
        fetchPaymentVouchersPage,
      }}
    >
      {clientReady ? children : <div role="status" aria-live="polite" className="body-pad">Loading workspace…</div>}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}

export function useStore() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('Store not ready');
  return ctx;
}
