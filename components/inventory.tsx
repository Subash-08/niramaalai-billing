'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, ArrowLeft, Package, Archive, RefreshCw, CheckCircle2 } from 'lucide-react';
import { Product, uid, money } from '@/lib/domain';
import { useStore } from './store';
import { PageHead, Card, Btn, Modal, Field, SearchBox, Badge, Empty } from './ui';

export const categories = [
  'Paper & sheets',
  'Cards',
  'Labels & stickers',
  'Banners & vinyl',
  'Books & stationery',
  'Frames & display materials',
  'Packaging',
  'Other print products',
];

export const commonUnits = [
  'Piece',
  'Sheet',
  'Ream',
  'Box',
  'Packet',
  'Roll',
  'Meter',
  'Kg',
  'Set',
];

export function ProductForm({
  product,
  onClose,
  page = false,
}: {
  product?: Product;
  onClose: () => void;
  page?: boolean;
}) {
  const { saveProductApi, notify } = useStore();
  const [f, setF] = useState<{
    id: string;
    name: string;
    description: string;
    category: string;
    unit: string;
    price: number;
    priceEntryMode: 'Inclusive' | 'Exclusive';
    tax: number;
    hsn: string;
    brand: string;
    model: string;
    status: 'Active' | 'Archived';
  }>(() => ({
    id: product?.id || uid('PRD'),
    name: product?.name || '',
    description: product?.description || '',
    category: product?.category || categories[0],
    unit: product?.unit || 'Piece',
    price: product?.price || 0,
    priceEntryMode: (product as any)?.priceEntryMode || 'Inclusive',
    tax: product?.tax ?? 18,
    hsn: product?.hsn || '',
    brand: product?.brand || '',
    model: product?.model || '',
    status: (product?.status as 'Active' | 'Archived') || 'Active',
  }));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set(k: string, v: unknown) {
    setF((x) => ({ ...x, [k]: v }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim()) {
      setError('Product name is required.');
      return;
    }
    if (f.price < 0) {
      setError('Selling rate must be non-negative.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const payload = {
        name: f.name.trim(),
        description: f.description.trim(),
        category: f.category,
        unit: f.unit.trim() || 'Piece',
        price: Number(f.price) || 0,
        priceEntryMode: f.priceEntryMode,
        tax: Number(f.tax) || 0,
        hsn: f.hsn.trim(),
        brand: f.brand.trim(),
        model: f.model.trim(),
        status: f.status,
        cost: 0,
        condition: 'New',
        stock: 0,
        low: 0,
        serials: [],
        warranty: 0,
        isSerialTracked: false,
      };

      const success = await saveProductApi(payload, product?.id);
      if (success) {
        onClose();
      } else {
        setError('Failed to save product. Check inputs and try again.');
      }
    } catch (err: any) {
      setError(err.message || 'Error saving product.');
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {error && (
        <div style={{ padding: '0.65rem', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: '6px', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Product Name <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
          </label>
          <input
            type="text"
            required
            value={f.name}
            placeholder="e.g. 300 GSM Art Card A4, Gloss Lamination Sheet"
            onChange={(e) => set('name', e.target.value)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Category <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
          </label>
          <select
            value={f.category}
            onChange={(e) => set('category', e.target.value)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          >
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
          Description / Specifications
        </label>
        <textarea
          rows={2}
          value={f.description}
          placeholder="Dimensions, finish, brand, paper weight details..."
          onChange={(e) => set('description', e.target.value)}
          style={{
            width: '100%',
            padding: '0.45rem 0.65rem',
            borderRadius: '6px',
            border: '1px solid var(--border, #d1d5db)',
            fontSize: '0.88rem',
          }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Unit of Measurement
          </label>
          <input
            type="text"
            list="units-list"
            value={f.unit}
            placeholder="Piece, Sheet, Ream..."
            onChange={(e) => set('unit', e.target.value)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          />
          <datalist id="units-list">
            {commonUnits.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Selling Rate (₹) <span style={{ color: 'var(--danger, #ef4444)' }}>*</span>
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            required
            value={f.price}
            onChange={(e) => set('price', parseFloat(e.target.value) || 0)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.95rem',
              fontWeight: 600,
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Price Mode
          </label>
          <select
            value={f.priceEntryMode}
            onChange={(e) => set('priceEntryMode', e.target.value as any)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          >
            <option value="Inclusive">Tax Inclusive</option>
            <option value="Exclusive">Tax Exclusive</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            GST Rate (%)
          </label>
          <select
            value={f.tax}
            onChange={(e) => set('tax', Number(e.target.value))}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          >
            <option value={0}>0% (Nil / Exempt)</option>
            <option value={5}>5%</option>
            <option value={12}>12%</option>
            <option value={18}>18%</option>
            <option value={28}>28%</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            HSN Code (Optional)
          </label>
          <input
            type="text"
            value={f.hsn}
            placeholder="e.g. 4802"
            onChange={(e) => set('hsn', e.target.value)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Brand / Manufacturer (Optional)
          </label>
          <input
            type="text"
            value={f.brand}
            placeholder="e.g. Century, Bilt, JK"
            onChange={(e) => set('brand', e.target.value)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Specification / Model (Optional)
          </label>
          <input
            type="text"
            value={f.model}
            placeholder="e.g. Matte Finish, High Gloss"
            onChange={(e) => set('model', e.target.value)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            Status
          </label>
          <select
            value={f.status}
            onChange={(e) => set('status', e.target.value as any)}
            style={{
              width: '100%',
              padding: '0.45rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border, #d1d5db)',
              fontSize: '0.9rem',
            }}
          >
            <option value="Active">Active</option>
            <option value="Archived">Archived</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
        <Btn secondary onClick={onClose} disabled={saving}>
          Cancel
        </Btn>
        <Btn type="submit" disabled={saving}>
          {saving ? 'Saving...' : product ? 'Update Product' : 'Add Product'}
        </Btn>
      </div>
    </form>
  );

  if (page) {
    return (
      <>
        <PageHead
          title={product ? 'Edit product' : 'New product'}
          description="Catalogue record used for invoice item selection and billing arithmetic."
        />
        <Card>{content}</Card>
      </>
    );
  }

  return (
    <Modal title={product ? 'Edit Product' : 'New Product'} onClose={onClose} wide>
      {content}
    </Modal>
  );
}

export default function Inventory({ id }: { id?: string }) {
  const router = useRouter();
  const { state, archiveProductApi, restoreProductApi, notify } = useStore();

  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [statusFilter, setStatusFilter] = useState<'All' | 'Active' | 'Archived'>('Active');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [creatingProduct, setCreatingProduct] = useState(false);

  // Filtered products list
  const filteredProducts = useMemo(() => {
    return (state.products || []).filter((p) => {
      if (selectedCategory !== 'All' && p.category !== selectedCategory) return false;
      const status = p.status || 'Active';
      if (statusFilter !== 'All' && status !== statusFilter) return false;

      if (search.trim()) {
        const q = search.toLowerCase();
        const matches =
          p.name.toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q) ||
          (p.hsn || '').toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q) ||
          (p.brand || '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [state.products, selectedCategory, statusFilter, search]);

  // If specific product ID selected
  const activeProduct = id ? state.products.find((p) => p.id === id) : null;

  if (activeProduct) {
    return (
      <div className="product-detail-view" style={{ padding: '0 0 2rem 0' }}>
        <div style={{ marginBottom: '1rem' }}>
          <button
            type="button"
            className="btn secondary"
            onClick={() => router.push('/inventory')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <ArrowLeft size={16} /> Back to products
          </button>
        </div>

        <PageHead
          title={activeProduct.name}
          description={`Catalogue product record · ${activeProduct.category}`}
          actions={
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Btn onClick={() => setEditingProduct(activeProduct)}>
                <Pencil size={15} /> Edit product
              </Btn>
              {activeProduct.status === 'Archived' ? (
                <Btn
                  secondary
                  onClick={async () => {
                    await restoreProductApi(activeProduct.id);
                  }}
                >
                  <RefreshCw size={15} /> Restore
                </Btn>
              ) : (
                <Btn
                  secondary
                  danger
                  onClick={async () => {
                    await archiveProductApi(activeProduct.id);
                  }}
                >
                  <Archive size={15} /> Archive
                </Btn>
              )}
            </div>
          }
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
          <Card title="Product Details">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.9rem' }}>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>Category: </span>
                <strong>{activeProduct.category}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>Unit of Measurement: </span>
                <strong>{activeProduct.unit || 'Piece'}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>HSN Code: </span>
                <strong>{activeProduct.hsn || 'Not specified'}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>Brand / Spec: </span>
                <strong>{[activeProduct.brand, activeProduct.model].filter(Boolean).join(' · ') || 'Standard'}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>Status: </span>
                <Badge>{activeProduct.status || 'Active'}</Badge>
              </div>
              {activeProduct.description && (
                <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: '0.5rem' }}>
                  <span style={{ color: 'var(--text-muted, #6b7280)', display: 'block', marginBottom: '2px' }}>Description:</span>
                  <p style={{ margin: 0, color: 'var(--text, #111827)' }}>{activeProduct.description}</p>
                </div>
              )}
            </div>
          </Card>

          <Card title="Pricing & Taxes">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.9rem' }}>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>Selling Rate: </span>
                <strong style={{ fontSize: '1.2rem', color: 'var(--primary, #6366f1)' }}>
                  {money(activeProduct.price)}
                </strong>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted, #6b7280)', marginLeft: '6px' }}>
                  / {activeProduct.unit || 'Piece'}
                </span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>Price Entry Mode: </span>
                <strong>{(activeProduct as any).priceEntryMode || 'Inclusive'}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted, #6b7280)' }}>GST Tax Rate: </span>
                <strong>{activeProduct.tax}%</strong>
              </div>
            </div>
          </Card>
        </div>

        {editingProduct && (
          <ProductForm
            product={editingProduct}
            onClose={() => setEditingProduct(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="inventory-page" style={{ padding: '0 0 3rem 0' }}>
      <PageHead
        title="Products"
        description="Catalogue products for customer invoices and billing calculations. Selectable line items without inventory tracking."
        actions={
          <Btn onClick={() => setCreatingProduct(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Plus size={16} /> Add product
          </Btn>
        }
      />

      <Card>
        {/* Filters bar */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.75rem',
            alignItems: 'center',
            marginBottom: '1.25rem',
            padding: '0.75rem',
            background: 'var(--surface-muted, #f9fafb)',
            borderRadius: '6px',
          }}
        >
          <div style={{ flex: '1 1 250px', minWidth: '200px' }}>
            <input
              type="text"
              placeholder="Search product name, category, HSN..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '0.45rem 0.65rem',
                fontSize: '0.85rem',
                borderRadius: '4px',
                border: '1px solid var(--border, #d1d5db)',
              }}
            />
          </div>

          <div>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              style={{
                padding: '0.45rem 0.65rem',
                fontSize: '0.85rem',
                borderRadius: '4px',
                border: '1px solid var(--border, #d1d5db)',
              }}
            >
              <option value="All">All Categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              style={{
                padding: '0.45rem 0.65rem',
                fontSize: '0.85rem',
                borderRadius: '4px',
                border: '1px solid var(--border, #d1d5db)',
              }}
            >
              <option value="Active">Active Only</option>
              <option value="Archived">Archived Only</option>
              <option value="All">All Statuses</option>
            </select>
          </div>

          <Btn
            secondary
            onClick={() => {
              setSearch('');
              setSelectedCategory('All');
              setStatusFilter('Active');
            }}
          >
            Reset
          </Btn>
        </div>

        {/* Product Table */}
        {filteredProducts.length === 0 ? (
          <Empty
            title="No products found"
            text="Add catalogue products for invoice line items."
            action={
              <Btn onClick={() => setCreatingProduct(true)}>
                <Plus size={16} /> Add product
              </Btn>
            }
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border, #e5e7eb)', textAlign: 'left' }}>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Product Name</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Category</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Unit</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>HSN</th>
                  <th style={{ padding: '0.65rem 0.75rem', textAlign: 'right' }}>Selling Rate</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>GST</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Status</th>
                  <th style={{ padding: '0.65rem 0.75rem', textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => {
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border, #f3f4f6)' }}>
                      <td style={{ padding: '0.65rem 0.75rem' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text, #111827)' }}>
                          <button
                            type="button"
                            onClick={() => router.push(`/inventory/${p.id}`)}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              font: 'inherit',
                              fontWeight: 600,
                              color: 'var(--primary, #6366f1)',
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            {p.name}
                          </button>
                        </div>
                        {p.description && (
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted, #6b7280)', marginTop: '2px' }}>
                            {p.description.slice(0, 70)}
                            {p.description.length > 70 ? '…' : ''}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', color: 'var(--text-muted, #4b5563)' }}>
                        {p.category}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem' }}>
                        {p.unit || 'Piece'}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                        {p.hsn || '-'}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', textAlign: 'right', fontWeight: 700 }}>
                        {money(p.price)}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem' }}>
                        {p.tax}%
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem' }}>
                        <Badge>{p.status || 'Active'}</Badge>
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', textAlign: 'center' }}>
                        <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                          <button
                            type="button"
                            className="btn secondary"
                            style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                            onClick={() => setEditingProduct(p)}
                            title="Edit Product"
                          >
                            <Pencil size={13} style={{ marginRight: '4px' }} /> Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Product Form Modal */}
      {(creatingProduct || editingProduct) && (
        <ProductForm
          product={editingProduct || undefined}
          onClose={() => {
            setCreatingProduct(false);
            setEditingProduct(null);
          }}
        />
      )}
    </div>
  );
}
