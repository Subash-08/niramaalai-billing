'use client';

import React from 'react';
import { Printer, Download, Truck } from 'lucide-react';
import { useStore } from './store';
import { Modal, Btn } from './ui';
import { TODAY } from '@/lib/domain';
import { deliveryChallanPdfBytes, downloadBytes } from '@/lib/exports';

export interface DeliveryChallanData {
  id?: string;
  invoiceNumber?: string;
  jobNumber?: string;
  date?: string;
  invoiceDate?: string;
  createdAt?: string;
  customerId?: string;
  customerSnapshot?: any;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  shipTo?: any;
  billTo?: any;
  lines?: any[];
  items?: any[];
  orderRef?: string;
  orderReference?: string;
  deliveryNote?: string;
  dispatch?: string;
  dispatchThrough?: string;
  notes?: string;
  description?: string;
  title?: string;
  unit?: string;
  quantity?: number;
  specifications?: any;
}

export default function DeliveryChallanModal({
  docData,
  onClose,
}: {
  docData: DeliveryChallanData;
  onClose: () => void;
}) {
  const { state, notify } = useStore();
  const settings = state.settings;

  const docId = docData.invoiceNumber || docData.jobNumber || docData.id || 'DOC';
  const challanNo = `DC-${docId}`;
  const challanDate = docData.invoiceDate || docData.date || (docData.createdAt ? String(docData.createdAt).slice(0, 10) : TODAY);

  const customer = docData.customerSnapshot ||
    state.customers.find((c: any) => c.id === docData.customerId) || {};
  const custName = docData.customerName || customer.name || 'Customer';
  const custPhone = docData.customerPhone || customer.phone || '';
  const custAddress = docData.customerAddress || customer.address || '';
  const shipTo = docData.shipTo;

  // Process items
  const lines = docData.lines || docData.items || [];

  async function handleDownloadPdf() {
    try {
      const bytes = await deliveryChallanPdfBytes(settings, docData, customer);
      downloadBytes(`delivery-challan-${docId}.pdf`, bytes, 'application/pdf');
      notify('Delivery Challan PDF downloaded.');
    } catch (err: any) {
      notify('PDF generation failed: ' + err.message);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <Modal title={`Delivery Challan ${challanNo}`} onClose={onClose} wide>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginBottom: '1rem' }} className="no-print">
        <Btn secondary onClick={handlePrint} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Printer size={15} /> Print
        </Btn>
        <Btn onClick={handleDownloadPdf} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Download size={15} /> Download PDF
        </Btn>
      </div>

      {/* Semantic Non-Financial Delivery Challan Container */}
      <div
        className="printable-document delivery-challan-document"
        style={{
          background: '#ffffff',
          color: '#111827',
          padding: '2rem',
          border: '1px solid #e5e7eb',
          borderRadius: '4px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          maxWidth: '800px',
          margin: '0 auto',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center', borderBottom: '2px solid #111827', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, letterSpacing: '2px' }}>DELIVERY CHALLAN</h1>
          <small style={{ color: '#4b5563', fontSize: '0.8rem', textTransform: 'uppercase' }}>
            Non-Financial Document · Goods Delivery Copy
          </small>
        </div>

        {/* Company & Challan Metadata Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '1.5rem', marginBottom: '1.25rem' }}>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '1.15rem', fontWeight: 700 }}>
              {settings.name || 'Company Name'}
            </h2>
            <div style={{ fontSize: '0.85rem', color: '#374151', lineHeight: '1.4' }}>
              {settings.address && <div>{settings.address}</div>}
              {settings.gst && <div><strong>GSTIN:</strong> {settings.gst}</div>}
              {settings.phone && <div><strong>Phone:</strong> {settings.phone}</div>}
              {settings.email && <div><strong>Email:</strong> {settings.email}</div>}
            </div>
          </div>

          <div style={{ borderLeft: '1px solid #e5e7eb', paddingLeft: '1rem', fontSize: '0.85rem', lineHeight: '1.6' }}>
            <div><strong>Challan No:</strong> {challanNo}</div>
            <div><strong>Date:</strong> {challanDate}</div>
            <div><strong>Ref Document:</strong> {docId}</div>
            {(docData.orderRef || docData.orderReference) && (
              <div><strong>Buyer Order:</strong> {docData.orderRef || docData.orderReference}</div>
            )}
            {docData.deliveryNote && (
              <div><strong>Delivery Note:</strong> {docData.deliveryNote}</div>
            )}
            {(docData.dispatch || docData.dispatchThrough) && (
              <div><strong>Dispatch Through:</strong> {docData.dispatch || docData.dispatchThrough}</div>
            )}
          </div>
        </div>

        {/* Bill to & Ship to */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '1rem',
            background: '#f9fafb',
            border: '1px solid #e5e7eb',
            borderRadius: '4px',
            padding: '0.75rem 1rem',
            marginBottom: '1.25rem',
            fontSize: '0.85rem',
          }}
        >
          <div>
            <strong>Bill To:</strong>
            <div style={{ fontWeight: 600, color: '#111827', marginTop: '2px' }}>{custName}</div>
            {custPhone && <div style={{ color: '#4b5563' }}>Phone: {custPhone}</div>}
            {custAddress && <div style={{ color: '#4b5563' }}>{custAddress}</div>}
          </div>

          <div>
            <strong>Ship To (Delivery Address):</strong>
            <div style={{ fontWeight: 600, color: '#111827', marginTop: '2px' }}>
              {shipTo?.name || custName}
            </div>
            {(shipTo?.phone || custPhone) && (
              <div style={{ color: '#4b5563' }}>Phone: {shipTo?.phone || custPhone}</div>
            )}
            {(shipTo?.address || custAddress) && (
              <div style={{ color: '#4b5563' }}>{shipTo?.address || custAddress}</div>
            )}
          </div>
        </div>

        {/* Items Table (Strictly Non-Financial: NO RATES, NO GST, NO TOTALS) */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1.25rem', fontSize: '0.88rem' }}>
          <thead>
            <tr style={{ background: '#1e293b', color: '#ffffff', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem', width: '45px' }}>S.No</th>
              <th style={{ padding: '0.5rem 0.75rem' }}>Description & Print Specifications</th>
              <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center', width: '120px' }}>Quantity</th>
            </tr>
          </thead>
          <tbody>
            {lines.length > 0 ? (
              lines.map((l: any, i: number) => {
                const specs = l.printSpecifications && typeof l.printSpecifications === 'object'
                  ? Object.entries(l.printSpecifications)
                      .filter(([, v]) => v)
                      .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1')}: ${v}`)
                      .join(' · ')
                  : '';

                return (
                  <tr key={i} style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <td style={{ padding: '0.6rem 0.75rem', textAlign: 'center' }}>{i + 1}</td>
                    <td style={{ padding: '0.6rem 0.75rem' }}>
                      <div style={{ fontWeight: 600 }}>{l.name || l.title || 'Print Job'}</div>
                      {l.details && <div style={{ fontSize: '0.8rem', color: '#4b5563', marginTop: '2px' }}>{l.details}</div>}
                      {specs && (
                        <div style={{ fontSize: '0.78rem', color: '#6366f1', marginTop: '3px', fontWeight: 500 }}>
                          {specs}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem', textAlign: 'center', fontWeight: 700 }}>
                      {l.qty ?? l.quantity ?? 1} {l.unit || 'Piece'}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '0.6rem 0.75rem', textAlign: 'center' }}>1</td>
                <td style={{ padding: '0.6rem 0.75rem' }}>
                  <div style={{ fontWeight: 600 }}>{docData.title || docData.description || 'Printing Services'}</div>
                  {docData.description && docData.title && (
                    <div style={{ fontSize: '0.8rem', color: '#4b5563', marginTop: '2px' }}>{docData.description}</div>
                  )}
                  {docData.specifications && typeof docData.specifications === 'object' && (
                    <div style={{ fontSize: '0.78rem', color: '#6366f1', marginTop: '3px', fontWeight: 500 }}>
                      {Object.entries(docData.specifications)
                        .filter(([, v]) => v)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ')}
                    </div>
                  )}
                </td>
                <td style={{ padding: '0.6rem 0.75rem', textAlign: 'center', fontWeight: 700 }}>
                  {docData.quantity || 1} {docData.unit || 'Job'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Delivery Terms / Notes */}
        <div
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '4px',
            padding: '0.75rem 1rem',
            fontSize: '0.82rem',
            color: '#475569',
            marginBottom: '2rem',
          }}
        >
          {docData.notes && <div style={{ marginBottom: '4px' }}><strong>Notes:</strong> {docData.notes}</div>}
          <div>Goods received in good condition and order. Any discrepancies must be reported upon delivery.</div>
        </div>

        {/* Dual Signatures */}
        <div style={{ marginTop: '3.5rem', display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
          <div style={{ textAlign: 'left', minWidth: '180px' }}>
            <div style={{ borderTop: '1px solid #111827', paddingTop: '4px' }}>
              Receiver's Signature & Date
            </div>
          </div>
          <div style={{ textAlign: 'right', minWidth: '180px' }}>
            <div style={{ borderTop: '1px solid #111827', paddingTop: '4px' }}>
              Authorised Signatory
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
