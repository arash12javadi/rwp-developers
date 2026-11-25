import { useCallback, useEffect, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { applyFilters } from '../../../src/core/hooks';
import {
  deleteProduct, importRelease, listProducts, listVersions, saveProduct, setVersionStatus, syncMarketplace, uploadVersion, verifyStored,
} from '../lib/api';
import type { DevProduct, DevVersion, ImportResult, UploadResult, VetReportShape } from '../lib/types';
import styles from '../developers.module.css';

const CATEGORIES = ['utility', 'commerce', 'marketing', 'seo', 'media', 'developer', 'integration'];
const SIX_HOURS =6 * 60 * 60 * 1000;
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');
const price = (value: number) => (Number(value) > 0 ? `$${Number(value).toFixed(2)}` : 'Free');
/** What the marketplace's `rwp_developers_marketplace_manage` component takes (rwp-plugin-marketplace/admin/DeveloperManage.tsx). */
interface MarketplaceManageProps { pluginId?: string | null; slug: string; onClose: () => void; onChanged: () => void }
const sizeLabel = (bytes: number) => (bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : '—');

function Findings({ report }: { report?: VetReportShape }) {
  const bad = (report?.checks || []).filter((check) => !check.ok);
  const flags = report?.flags || [];
  if (!bad.length && !flags.length) return <p className={styles.hint}>The scan found nothing.</p>;
  return (
    <ul className={styles.findings}>
      {bad.map((check) => <li key={check.name}><strong>{check.name}</strong> — {check.detail}</li>)}
      {flags.filter((flag) => !bad.some((check) => flag.includes(check.name))).slice(0, 8).map((flag) => <li key={flag}>{flag}</li>)}
    </ul>
  );
}

/** Versions of one plugin: upload a ZIP, import a GitHub release, publish, withdraw, check the stored copy. */
function VersionsPanel({ product, onChanged }: { product: DevProduct; onChanged: () => void }) {
  const [versions, setVersions] = useState<DevVersion[] | null>(null);
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [last, setLast] = useState<UploadResult | ImportResult | null>(null);

  const load = useCallback(() => {
    listVersions(product.id).then(setVersions).catch((loadError: unknown) => { setVersions([]); setError(errorText(loadError, 'Could not load the versions.')); });
  }, [product.id]);
  useEffect(() => { load(); }, [load, product.current_version]);

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { setError('Choose the plugin ZIP first.'); return; }
    setBusy('upload');
    setError('');
    setMessage('');
    setLast(null);
    try {
      const result = await uploadVersion({ productId: product.id, version: version.trim(), changelog, file, acceptFindings: accept });
      setLast(result);
      setMessage(result.held
        ? `${result.version} was stored but is held back: the scan found something to read. Publish it below once you are happy with it.`
        : `${result.version} is published${result.current ? ' and is now the version your shop offers.' : '.'}`);
      setFile(null);
      setFileKey((key) => key + 1);
      setVersion('');
      setChangelog('');
      load();
      onChanged();
    } catch (uploadError) {
      setError(errorText(uploadError, 'The upload failed.'));
    } finally {
      setBusy('');
    }
  };

  const decide = async (entry: DevVersion, status: 'published' | 'withdrawn') => {
    setBusy(`${status}:${entry.id}`);
    setError('');
    setMessage('');
    try {
      const result = await setVersionStatus(entry.id, status);
      setMessage(status === 'published'
        ? `${entry.version} is published. Your shop now offers ${result.current_version || 'nothing'}.`
        : `${entry.version} was withdrawn. Your shop now offers ${result.current_version || 'nothing'}.`);
      load();
      onChanged();
    } catch (decisionError) {
      setError(errorText(decisionError, 'Could not change that version.'));
    } finally {
      setBusy('');
    }
  };

  const verify = async (entry: DevVersion) => {
    setBusy(`verify:${entry.id}`);
    setError('');
    setMessage('');
    try {
      const result = await verifyStored(entry.id);
      if (result.ok) setMessage(`${entry.version}: the stored file matches its recorded checksum.`);
      else setError(`${entry.version}: the stored file does NOT match its recorded checksum. Upload the version again.`);
    } catch (verifyError) {
      setError(errorText(verifyError, 'Could not read the stored file.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <h4 className={styles.panelTitle}>Versions</h4>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}

      <form onSubmit={upload}>
        <div className={styles.row}>
          <div className={styles.field} style={{ flex: '0 1 140px' }}>
            <label htmlFor={`ver-${product.id}`}>Version</label>
            <input id={`ver-${product.id}`} className={styles.input} value={version} disabled={busy !== ''} placeholder="1.0.1" onChange={(event) => setVersion(event.target.value)} />
          </div>
          <div className={styles.field} style={{ flex: '2 1 260px' }}>
            <label htmlFor={`zip-${product.id}`}>Plugin package (.zip)</label>
            <input key={fileKey} id={`zip-${product.id}`} className={styles.input} type="file" accept=".zip" disabled={busy !== ''} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </div>
        </div>
        <div className={styles.field}>
          <label htmlFor={`log-${product.id}`}>What changed</label>
          <textarea id={`log-${product.id}`} className={styles.textarea} rows={2} value={changelog} disabled={busy !== ''} onChange={(event) => setChangelog(event.target.value)} />
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={accept} disabled={busy !== ''} onChange={(event) => setAccept(event.target.checked)} />
          <span>Publish even if the scan finds something to read (network calls, storage access). A blocking problem is never published.</span>
        </label>
        <p className={styles.hint}>
          The version has to match <code>version</code> in the ZIP&rsquo;s <code>manifest.json</code>, and its <code>id</code> has to be <code>{product.slug}</code>.
          Packages over about 4 MB cannot go through a Vercel function: use a GitHub release for larger plugins.
        </p>
        <button type="submit" className={styles.button} disabled={busy !== ''}>{busy === 'upload' ? 'Scanning and storing…' : 'Scan and upload'}</button>
      </form>
      {last?.report && (last.severity !== 'clean') && (
        <div className={styles.warn}><strong>Scan report ({last.severity})</strong><Findings report={last.report} /></div>
      )}

      {!versions ? <p className={styles.muted}>Loading versions…</p> : !versions.length ? <p className={styles.hint}>No version uploaded yet.</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Version</th><th>Status</th><th>Source</th><th>Size</th><th>Uploaded</th><th>Actions</th></tr></thead>
            <tbody>
              {versions.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>{entry.version}</strong>{entry.version === product.current_version && <> <span className={`${styles.badge} ${styles.ready}`}>offered</span></>}
                    {entry.changelog && <><br /><span className={styles.muted}>{entry.changelog.slice(0, 160)}</span></>}
                    {entry.status === 'held' && <details><summary>Scan report</summary><Findings report={entry.vet_report} /></details>}
                    <br /><code title={entry.sha256}>{entry.sha256.slice(0, 12)}</code>
                  </td>
                  <td><span className={`${styles.badge} ${styles[entry.status]}`}>{entry.status}</span></td>
                  <td>{entry.source === 'github' ? 'GitHub release' : 'ZIP upload'}</td>
                  <td>{sizeLabel(entry.size)}</td>
                  <td>{when(entry.created_at)}</td>
                  <td>
                    {entry.status !== 'published' && (
                      <button type="button" className={styles.button} disabled={busy !== ''} onClick={() => decide(entry, 'published')}>Publish</button>
                    )}{' '}
                    {entry.status !== 'withdrawn' && (
                      <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy !== ''} onClick={() => decide(entry, 'withdrawn')}>Withdraw</button>
                    )}{' '}
                    <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy !== ''} onClick={() => verify(entry)}>
                      {busy === `verify:${entry.id}` ? 'Checking…' : 'Check file'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One plugin: its details, its GitHub link, and its versions. */
function ProductPanel({ product, onChanged, onDeleted, onClose }: { product: DevProduct; onChanged: () => void; onDeleted: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(product.title);
  const [description, setDescription] = useState(product.description);
  const [category, setCategory] = useState(product.category);
  const [amount, setAmount] = useState(String(product.price));
  const [days, setDays] = useState(product.license_days ? String(product.license_days) : '');
  const [status, setStatus] = useState(product.status);
  const [releaseSource, setReleaseSource] = useState<'github' | 'zip'>(product.release_source === 'zip' ? 'zip' : 'github');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('save');
    setError('');
    setMessage('');
    try {
      await saveProduct({ id: product.id, title, description, category, price: Number(amount), license_days: days.trim() ? Number(days) : null, status, release_source: releaseSource });
      setMessage('Saved.');
      onChanged();
    } catch (saveError) {
      setError(errorText(saveError, 'Could not save.'));
    } finally {
      setBusy('');
    }
  };

  const check = async (newToken = '') => {
    setBusy('check');
    setError('');
    setMessage('');
    try {
      const result = await importRelease({ product_id: product.id, ...(newToken ? { token: newToken } : {}) });
      if (newToken) setToken('');
      setMessage(result.changed
        ? `Release ${result.tag || result.version} was found, scanned and stored.${result.held ? ' It is held back until you publish it below.' : ''}`
        : (result.message || 'There is no newer release.'));
      onChanged();
    } catch (checkError) {
      setError(errorText(checkError, 'Could not read the release.'));
      onChanged();
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    setBusy('delete');
    setError('');
    try {
      await deleteProduct(product.id);
      onDeleted();
    } catch (deleteError) {
      setError(errorText(deleteError, 'Could not delete the plugin.'));
      setConfirm(false);
    } finally {
      setBusy('');
    }
  };

  if (product.managed_by === 'marketplace') {
    // With the marketplace active, Manage opens its Inventory dialog (without the owner's decisions); otherwise a read-only summary.
    const MarketplaceManage = applyFilters<ComponentType<MarketplaceManageProps> | null>('rwp_developers_marketplace_manage', null);
    if (MarketplaceManage) {
      return <MarketplaceManage pluginId={product.marketplace_plugin_id} slug={product.slug} onClose={onClose} onChanged={onChanged} />;
    }
    return (
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>{product.title} <span className={styles.muted}>({product.slug})</span></h3>
        <p className={styles.notice} role="status">
          This plugin is managed by the <strong>Marketplace</strong>, which rules it and sells it. It is shown here so every plugin of yours is in one list;
          its title, price, status, versions and GitHub release are changed in Marketplace → Inventory → Manage, and the change shows up here the next time
          this list opens. The developer shop does not sell it.
        </p>
        <ul className={styles.hint}>
          <li>Price: {price(product.price)} · Status: {product.status === 'published' ? 'live in the marketplace' : product.status} · Version: {product.current_version || '—'}</li>
          {product.source_repo && <li>GitHub: <code>{product.source_repo}</code>{product.source_private ? ' (private)' : ''}{product.source_last_tag ? ' · latest seen ' + product.source_last_tag : ''} · last checked {when(product.source_checked_at)}</li>}
          {product.source_error && <li className={styles.error}>The last release check failed: {product.source_error}</li>}
        </ul>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>{product.title} <span className={styles.muted}>({product.slug})</span></h3>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}
      <form onSubmit={save}>
        <div className={styles.row}>
          <div className={styles.field} style={{ flex: '2 1 260px' }}>
            <label htmlFor={`t-${product.id}`}>Title</label>
            <input id={`t-${product.id}`} className={styles.input} value={title} disabled={busy !== ''} onChange={(event) => setTitle(event.target.value)} required />
          </div>
          <div className={styles.field} style={{ flex: '0 1 150px' }}>
            <label htmlFor={`c-${product.id}`}>Category</label>
            <select id={`c-${product.id}`} className={styles.select} value={category} disabled={busy !== ''} onChange={(event) => setCategory(event.target.value)}>
              {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className={styles.field} style={{ flex: '0 1 130px' }}>
            <label htmlFor={`p-${product.id}`}>Price (USD, 0 = free)</label>
            <input id={`p-${product.id}`} className={styles.input} type="number" min="0" step="0.01" value={amount} disabled={busy !== ''} onChange={(event) => setAmount(event.target.value)} />
          </div>
          <div className={styles.field} style={{ flex: '0 1 150px' }}>
            <label htmlFor={`d-${product.id}`}>Licence lasts (days)</label>
            <input id={`d-${product.id}`} className={styles.input} type="number" min="1" max="3650" value={days} placeholder="Lifetime" disabled={busy !== ''} onChange={(event) => setDays(event.target.value)} />
          </div>
          <div className={styles.field} style={{ flex: '0 1 200px' }}>
            <label htmlFor={`r-${product.id}`}>Which source rules the live version</label>
            <select id={`r-${product.id}`} className={styles.select} value={releaseSource} disabled={busy !== ''} onChange={(event) => setReleaseSource(event.target.value === 'zip' ? 'zip' : 'github')}>
              <option value="github">Latest GitHub release (default)</option>
              <option value="zip">Newest uploaded ZIP</option>
            </select>
          </div>
          <div className={styles.field} style={{ flex: '0 1 150px' }}>
            <label htmlFor={`s-${product.id}`}>In the shop</label>
            <select id={`s-${product.id}`} className={styles.select} value={status} disabled={busy !== ''} onChange={(event) => setStatus(event.target.value as DevProduct['status'])}>
              <option value="draft">Draft (hidden)</option>
              <option value="published">On sale</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>
        <div className={styles.field}>
          <label htmlFor={`x-${product.id}`}>Description</label>
          <textarea id={`x-${product.id}`} className={styles.textarea} rows={3} value={description} disabled={busy !== ''} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <p className={styles.hint}>
          {product.current_version ? `The shop offers version ${product.current_version}.` : 'No version is published yet, so this plugin cannot be put on sale.'}
          {' '}The shop offers the newest published version of the source you choose; until that source has a version, the other one is offered.
          {' '}The id <code>{product.slug}</code> cannot change: licence keys are issued for it.
        </p>
        <button type="submit" className={styles.button} disabled={busy !== ''}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </form>

      {product.source_repo && (
        <div style={{ marginTop: 14 }}>
          <h4 className={styles.panelTitle}>GitHub release</h4>
          <p className={styles.hint}>
            Linked to {product.source_private
              ? <code>{product.source_repo}</code>
              : <a href={`https://github.com/${product.source_repo}`} target="_blank" rel="noreferrer">{product.source_repo}</a>}{product.source_private ? ' (private)' : ''}.
            Its latest release is read when you press the button, and whenever this screen opens more than six hours after the last look.
            {product.source_last_tag ? ` Latest seen: ${product.source_last_tag}.` : ''} Last checked {when(product.source_checked_at)}.
          </p>
          {product.source_error && <p className={styles.error}>The last check could not use the release: {product.source_error}</p>}
          <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy !== ''} onClick={() => check()}>{busy === 'check' ? 'Checking GitHub…' : 'Check for new release'}</button>
          {(product.source_private || Number(product.price) > 0) && (
            <div className={styles.field} style={{ marginTop: 10 }}>
              <label htmlFor={`k-${product.id}`}>Replace the repository access token</label>
              <input id={`k-${product.id}`} className={styles.input} type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy !== ''}
                placeholder="github_pat_… (read-only “Contents” access to this one repository)" onChange={(event) => setToken(event.target.value)} />
              <p className={styles.hint}>A plugin you sell comes from a private repository. The token is sealed in your database and never shown again.</p>
              <button type="button" className={styles.button} disabled={busy !== '' || token.trim().length < 20} onClick={() => check(token.trim())}>Save token and check</button>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}><VersionsPanel product={product} onChanged={onChanged} /></div>

      <div style={{ marginTop: 14 }}>
        <h4 className={styles.panelTitle}>Remove</h4>
        {confirm ? (
          <div className={styles.row}>
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy !== ''} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Yes, delete it and its packages'}</button>
            <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setConfirm(false)}>Keep it</button>
          </div>
        ) : (
          <button type="button" className={`${styles.button} ${styles.danger}`} onClick={() => setConfirm(true)}>Delete this plugin…</button>
        )}
        <p className={styles.hint}>A plugin that has been ordered cannot be deleted (its licences must be kept): archive it instead.</p>
      </div>
    </div>
  );
}

/** Developers → Plugins: create, import from GitHub, edit, version, delete. */
export default function ProductsAdmin() {
  const [products, setProducts] = useState<DevProduct[] | null>(null);
  const [openId, setOpenId] = useState('');
  const [mode, setMode] = useState<'' | 'new' | 'github'>('');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [repo, setRepo] = useState('');
  const [repoToken, setRepoToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const autoChecked = useRef(false);

  const load = useCallback(() => {
    // The owner's marketplace plugins are mirrored first (quietly: a site without the marketplace just answers ).
    syncMarketplace().catch(() => undefined).then(() => listProducts()).then(setProducts).catch((loadError: unknown) => { setProducts([]); setError(errorText(loadError, 'Could not load your plugins. Has the Developers plugin been activated so its database schema is installed?')); });
  }, []);
  useEffect(() => { load(); }, [load]);

  // Plugins linked to GitHub look for a new release by themselves, at most every six hours, when this screen opens.
  useEffect(() => {
    if (!products || autoChecked.current) return;
    autoChecked.current = true;
    const due = products.filter((product) => product.source_repo && !product.managed_by && (!product.source_checked_at || Date.now() - Date.parse(product.source_checked_at) > SIX_HOURS)).slice(0, 3);
    if (!due.length) return;
    void (async () => {
      for (const product of due) await importRelease({ product_id: product.id }).catch(() => undefined);
      load();
    })();
  }, [products, load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { product } = await saveProduct({ slug: slug.trim().toLowerCase(), title: title.trim() });
      setSlug('');
      setTitle('');
      setMode('');
      setMessage(`“${product.title}” was created as a draft. Upload a version, then put it on sale.`);
      load();
      setOpenId(product.id);
    } catch (createError) {
      setError(errorText(createError, 'Could not create the plugin.'));
    } finally {
      setBusy(false);
    }
  };

  const fromGithub = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await importRelease({ repository_url: repo.trim(), ...(repoToken.trim() ? { token: repoToken.trim() } : {}) });
      setRepo('');
      setRepoToken('');
      setMode('');
      setMessage(`“${result.slug}” ${result.version} was imported from ${result.tag}. ${result.held ? 'The scan found something to read, so it is held back until you publish it.' : 'It is a draft: set its price and put it on sale.'}`);
      load();
      if (result.product_id) setOpenId(result.product_id);
    } catch (importError) {
      setError(errorText(importError, 'Could not read that repository.'));
    } finally {
      setBusy(false);
    }
  };

  const open = (products || []).find((product) => product.id === openId) || null;

  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>Your plugins</h2>
      <p className={styles.subtitle}>
        Publish plugins from this site: import a GitHub release (the default) or upload a ZIP, choose which of the two rules the version your shop offers, set a price (or leave it free), and sell them
        with your own payment accounts. Each version is scanned before it is stored; packages sit in your own private storage.
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}

      <div className={styles.row}>
        <button type="button" className={mode === 'new' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => setMode(mode === 'new' ? '' : 'new')}>New plugin</button>
        <button type="button" className={mode === 'github' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => setMode(mode === 'github' ? '' : 'github')}>Import from a GitHub release</button>
      </div>

      {mode === 'new' && (
        <form className={styles.panel} onSubmit={create}>
          <div className={styles.row}>
            <div className={styles.field}>
              <label htmlFor="new-slug">Plugin id</label>
              <input id="new-slug" className={styles.input} value={slug} required spellCheck={false} placeholder="my-plugin" disabled={busy} onChange={(event) => setSlug(event.target.value)} />
            </div>
            <div className={styles.field}>
              <label htmlFor="new-title">Title</label>
              <input id="new-title" className={styles.input} value={title} required disabled={busy} onChange={(event) => setTitle(event.target.value)} />
            </div>
          </div>
          <p className={styles.hint}>The id is what <code>manifest.json</code> says and what licence keys are issued for; it cannot be changed later.</p>
          <button type="submit" className={styles.button} disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
        </form>
      )}

      {mode === 'github' && (
        <form className={styles.panel} onSubmit={fromGithub}>
          <div className={styles.field}>
            <label htmlFor="gh-repo">Repository address</label>
            <input id="gh-repo" className={styles.input} value={repo} required spellCheck={false} placeholder="https://github.com/you/your-plugin" disabled={busy} onChange={(event) => setRepo(event.target.value)} />
          </div>
          <div className={styles.field}>
            <label htmlFor="gh-token">Access token (only for a private repository)</label>
            <input id="gh-token" className={styles.input} type="password" autoComplete="off" spellCheck={false} value={repoToken} placeholder="github_pat_… (leave empty for a public repository)" disabled={busy} onChange={(event) => setRepoToken(event.target.value)} />
          </div>
          <p className={styles.hint}>
            A repository with a published release (tag such as <code>v1.0.0</code>, equal to <code>version</code> in its <code>manifest.json</code>).
            The release is read, scanned and copied into your private storage. A plugin you <strong>sell</strong> must come from a <strong>private</strong> repository: paste a
            fine-grained token with read-only &ldquo;Contents&rdquo; access to that one repository. It is sealed in your database and never shown again. A free plugin from a public repository needs no token.
          </p>
          <button type="submit" className={styles.button} disabled={busy}>{busy ? 'Reading the release…' : 'Import'}</button>
        </form>
      )}

      {!products ? <p className={styles.muted}>Loading…</p> : !products.length ? (
        <p className={styles.hint}>You have no plugins here yet.</p>
      ) : (
        <div className={styles.panel}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Plugin</th><th>Price</th><th>Version</th><th>Status</th><th /></tr></thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td><strong>{product.title}</strong>{product.managed_by === 'marketplace' && <> <span className={styles.badge}>Marketplace</span></>}<br /><span className={styles.muted}>{product.slug}{product.source_repo ? ` · ${product.source_repo}` : ''}</span></td>
                    <td>{price(product.price)}</td>
                    <td>{product.current_version || '—'}</td>
                    <td><span className={`${styles.badge} ${styles[product.status]}`}>{product.status === 'published' ? (product.managed_by === 'marketplace' ? 'live (marketplace)' : 'on sale') : product.status}</span></td>
                    <td><button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setOpenId(openId === product.id ? '' : product.id)}>{openId === product.id ? 'Close' : 'Manage'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {open && <ProductPanel key={open.id} product={open} onChanged={load} onClose={() => setOpenId('')} onDeleted={() => { setOpenId(''); setMessage('The plugin was deleted.'); load(); }} />}
    </div>
  );
}
