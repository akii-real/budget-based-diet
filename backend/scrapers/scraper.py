"""
Live ingredient price scraping (Blinkit / Zepto / Instamart).

Meal plans and ingredient lists come from Mongo via the Node API
(POST /refresh-ingredient-prices with an `ingredients` array). This file only
handles one ingredient per invocation: --single "<name>".

For simulated prices, use simulate_prices.py (or set PRICE_DATA_SOURCE=simulate on the backend).
"""

import json
import os
import platform
import re
import sys
import time
import tempfile
from urllib.parse import quote
from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.edge.options import Options
from selenium.webdriver.edge.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

load_dotenv()

# Blinkit / Zepto / Instamart are JS-heavy SPAs; prices load after XHR/fetch.
# BeautifulSoup on first HTML alone is usually not enough — use this driver + DOM/API work,
# or call official/partner APIs if available.

PLATFORMS = ["Blinkit", "Zepto", "Instamart"]

# Default matches common zepto.com layout; India may use zeptonow.com — set ZEPTO_BASE_URL if needed.
ZEPTO_HOME_URL = os.getenv("ZEPTO_BASE_URL", "https://www.zepto.com/").strip()


def normalize_ingredient_name(s):
    """Canonical key for MongoDB (lowercase, single spaces)."""
    return " ".join(str(s).strip().lower().split())


def _ingredient_tokens(normalized_query: str):
    """Tokens used to match grocery titles and reject obvious non-food."""
    parts = re.split(r"[^a-z0-9]+", normalized_query.lower())
    return [p for p in parts if len(p) > 1]


def _zepto_expand_queries(normalized_query: str):
    """
    Try more specific Zepto search strings first for ambiguous one-word queries,
    so SERPs skew toward grocery (e.g. 'apple' -> Apple Shimla fruit, not gadgets).
    """
    q = (normalized_query or "").strip().lower()
    variants = {
        "apple": ["apple shimla", "apple fruit", "apple kinnaur", "apple"],
        "orange": ["orange fruit", "orange"],
        "salt": ["iodized salt", "table salt", "salt"],
        "oil": ["cooking oil", "sunflower oil", "oil"],
        "rice": ["sona masoori rice", "basmati rice", "rice"],
    }
    out, seen = [], set()
    for x in variants.get(q, [q]):
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


# Reject electronics / gadgets / personal care that often appear on grocery searches (e.g. "apple").
_NON_FOOD_TITLE_RE = re.compile(
    r"(iphone|ipad|ipod|iwatch|\bairpods\b|macbook|\bimac\b|apple\s*watch|apple\s*tv|"
    r"\bwatch\b.*(series|se|ultra|gps|cellular)|\bgalaxy\s+watch\b|"
    r"usb[-\s]?c|\bmouse\b|\bkeyboard\b|headphone|\bearbuds\b|earphone|bluetooth|wireless\s*charger|"
    r"\bcharger\b|\badapter\b|power\s*adapter|power\s*bank|"
    r"\bcable\b|hdmi|lightning|vga|router|modem|tempered\s*glass|screen\s*guard|"
    r"\bmah\b|\bgb\b|\btb\b|\bram\b|\brom\b|\bwatt\b|\bhz\b|"
    r"smart\s*watch|fitness\s*band|tablet|\blaptop\b|"
    r"motor\s*oil|engine\s*oil|lubricant|wd[-\s]?40|"
    r"\bcase\b\s*(for|compatible)|\bcover\b\s*(for|compatible)|"
    r"\bjbl\b|\bsony\s+wh|\boneplus\b|\bdell\b|\blenovo\b|\bhp\b\s*pavilion|\basus\b\s*rog|"
    r"\bhair\s*care\b|\bhair\s*fall\b|\bthinning\b|\bbody\s*care\b|\bface\s*care\b|\bbeauty\s+care\b|\bpet\s*care\b)",
    re.I,
)


def _is_likely_food_grocery(text: str) -> bool:
    """False if text clearly matches non-grocery patterns; True if unknown/empty."""
    if not text or not str(text).strip():
        return True
    if _NON_FOOD_TITLE_RE.search(text):
        return False
    return True


def _title_matches_ingredient(title: str, tokens) -> bool:
    if not tokens:
        return True
    tl = title.lower()
    return any(t in tl for t in tokens)


def _parse_inr_prices_from_blob(blob: str):
    """Return candidate selling prices from visible text (₹142, ₹1,499). Skips ₹8 OFF style lines."""
    out = []
    for ln in blob.split("\n"):
        if re.search(r"\boff\b", ln, re.I) and re.search(r"(?:₹|rs\.?)", ln, re.I):
            continue
        for x in re.findall(r"(?:₹|rs\.?)\s*([\d,]+)", ln, re.I):
            try:
                out.append(int(x.replace(",", "")))
            except ValueError:
                continue
    return out


def _pick_selling_price_inr(prices):
    if not prices:
        return None
    if len(prices) == 1:
        return prices[0]
    return min(prices)


def _quantity_to_kg(quantity_line: str) -> float:
    """
    Best-effort grams/kg/ml → kg for price_per_kg. Falls back to a small default when unknown.
    """
    if not quantity_line:
        return 0.25
    s = quantity_line.lower().replace(" ", "")
    m = re.search(r"\(\s*(\d+)\s*g\s*\)", quantity_line, re.I)
    if m:
        return int(m.group(1)) / 1000.0
    m = re.search(r"(\d+(?:\.\d+)?)\s*kg\b", s)
    if m:
        return float(m.group(1))
    m = re.search(r"(\d+(?:\.\d+)?)\s*(g|gm)\b", s)
    if m:
        return float(m.group(1)) / 1000.0
    m = re.search(r"(\d+(?:\.\d+)?)\s*(ml|l|litre|liter)\b", s)
    if m:
        v, u = float(m.group(1)), m.group(2).lower()
        ml = v * 1000 if u.startswith("l") else v
        return ml / 1000.0
    m = re.search(r"(\d+)\s*pcs?\b", s)
    if m:
        return int(m.group(1)) * 0.12
    m = re.search(r"(\d+)\s*pack", s)
    if m:
        return max(0.1, int(m.group(1)) * 0.2)
    return 0.25


def _extract_title_price_qty_from_card_text(blob: str, tokens):
    """Parse Zepto-style card plain text into (title, selling_inr, quantity_line)."""
    lines = [ln.strip() for ln in blob.split("\n") if ln.strip()]
    lines = [ln for ln in lines if ln.upper() != "ADD" and "see all" not in ln.lower()]
    prices = _parse_inr_prices_from_blob("\n".join(lines))
    selling = _pick_selling_price_inr(prices)
    qty_line = ""
    for ln in lines:
        if re.search(r"\d+\s*(pcs?|pack|pkts?|g|kg|ml|l|litre|liter)\b", ln, re.I):
            if "min" in ln.lower():
                continue
            qty_line = ln
            break
    title_candidates = []
    for ln in lines:
        low = ln.lower()
        if "₹" in ln or "min" in low:
            continue
        if re.search(r"\d+\s*(pcs?|pack|pkts?|g|kg|ml|l|litre|liter)\b", ln, re.I):
            continue
        if re.fullmatch(r"\d+%?\s*off|₹\s*\d+\s*off", low, re.I):
            continue
        if re.fullmatch(r"(off|sale|new|best price|buy now|see all)\b", low, re.I):
            continue
        if len(ln) < 2:
            continue
        if re.match(r"^[\d\s₹,%\-]+$", ln):
            continue
        if re.match(r"^\d+(\.\d+)?$", ln.strip()):
            continue
        title_candidates.append(ln)
    title = ""
    if tokens and title_candidates:
        tl = [t for t in tokens if len(t) > 2]
        for ln in title_candidates:
            ll = ln.lower()
            if any(t in ll for t in tl):
                title = ln
                break
    if not title and title_candidates:
        title = title_candidates[0]
    return title, selling, qty_line


def _zepto_find_search_input(driver, wait_s=25, *, require_visible: bool = True):
    """Header search on Zepto is often a controlled React input; try several XPaths."""
    wait = WebDriverWait(driver, wait_s)
    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.35)
    except Exception:
        pass
    time.sleep(0.5)
    xpaths = [
        "//input[@type='search']",
        "//*[@data-testid and contains(translate(@data-testid,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//header//input[@type='text']",
        "//nav//following::input[@type='text'][1]",
        "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//input[contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//input[contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//input[contains(translate(@id,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//input[contains(translate(@name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//input[starts-with(@placeholder,'Search') or starts-with(@placeholder,'search')]",
    ]
    last_err = None
    for xp in xpaths:
        try:
            el = wait.until(EC.presence_of_element_located((By.XPATH, xp)))
            w = el.rect.get("width", 0) or 0
            if require_visible:
                if el.is_displayed() and w > 60:
                    return el
            elif w > 25 or el.is_displayed():
                return el
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(
        "Zepto search input not found. "
        f"Last error: {last_err!r}. Check ZEPTO_BASE_URL matches the site you use in the browser."
    ) from last_err


def _zepto_click_search_bar(driver, wait_s=20):
    """
    Zepto often needs a real click on the visible search bar (or its wrapper) before the
    inner input accepts typing / React attaches listeners.
    """
    wait = WebDriverWait(driver, wait_s)
    xpaths = [
        "//input[contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//input[@type='search']",
        "//header//input[@type='text'][contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'search')]",
        "//header//input[@type='text']",
    ]
    last = None
    for xp in xpaths:
        try:
            inp = wait.until(EC.presence_of_element_located((By.XPATH, xp)))
            driver.execute_script("arguments[0].scrollIntoView({block:'center', inline:'center'});", inp)
            time.sleep(0.15)
            try:
                WebDriverWait(driver, 5).until(EC.element_to_be_clickable((By.XPATH, xp)))
                inp.click()
            except Exception:
                try:
                    driver.execute_script(
                        """
                        const el = arguments[0];
                        try { el.click(); } catch (e1) {}
                        const p = el.parentElement;
                        if (p) { try { p.click(); } catch (e2) {} }
                        const g = el.closest('form, [role="search"], header');
                        if (g && g !== el && g !== p) { try { g.click(); } catch (e3) {} }
                        """,
                        inp,
                    )
                except Exception:
                    _js_click(driver, inp)
            time.sleep(0.55)
            return
        except Exception as e:
            last = e
            continue
    raise RuntimeError(
        "Zepto: could not click the header search bar. "
        f"Last error: {last!r}. Check ZEPTO_BASE_URL and that the homepage finished loading."
    ) from last


def _zepto_blob_has_price_indicators(blob: str) -> bool:
    if not blob:
        return False
    return bool(re.search(r"(?:₹|rs\.?)\s*\d", blob, re.I))


def _zepto_try_navigate_to_search(driver, query: str, *, wait_s=18) -> bool:
    """
    Open Zepto search results via GET (multiple URL shapes). Often survives UI refactors
    better than typing into the header search box.
    """
    base = ZEPTO_HOME_URL.rstrip("/")
    paths = (
        f"/search?query={quote(query)}",
        f"/search?q={quote(query)}",
        f"/search?search={quote(query)}",
        f"/search/{quote(query)}",
        f"/s?k={quote(query)}",
    )
    deadline = time.time() + max(5.0, float(wait_s))
    for path in paths:
        if time.time() > deadline:
            break
        try:
            driver.get(f"{base}{path}")
        except Exception:
            continue
        for _ in range(22):
            time.sleep(0.35)
            if len(_zepto_product_card_elements(driver)) >= 1:
                driver.execute_script("window.scrollTo(0, 400);")
                time.sleep(0.45)
                return True
            if time.time() > deadline:
                break
    return False


def _zepto_run_search(driver, query: str, wait_s=25):
    """
    Click the visible search bar, then type the query into the (re-found) input and press Enter.
    Falls back to in-page JS value set if keyboard typing fails.
    """
    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.35)
    except Exception:
        pass
    time.sleep(0.5)

    if _zepto_try_navigate_to_search(driver, query, wait_s=min(wait_s, 18)):
        return

    _zepto_click_search_bar(driver, wait_s=min(wait_s, 25))

    inp = None
    try:
        inp = _zepto_find_search_input(driver, wait_s=min(wait_s, 20), require_visible=True)
    except Exception:
        inp = None
    if inp is None:
        try:
            inp = _zepto_find_search_input(driver, wait_s=min(wait_s, 15), require_visible=False)
        except Exception:
            inp = None

    if inp is not None:
        try:
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", inp)
            time.sleep(0.1)
            mod = Keys.COMMAND if platform.system() == "Darwin" else Keys.CONTROL
            inp.click()
            time.sleep(0.15)
            inp.send_keys(mod, "a")
            inp.send_keys(Keys.BACKSPACE)
            inp.send_keys(query)
        except Exception:
            inp = None

    if inp is None:
        ok = driver.execute_script(
            """
            const q = arguments[0];
            const vis = (n) => n && n.offsetParent !== null && !n.disabled;
            const bad = (t) => ['checkbox','radio','file','submit','button','image'].includes(t);
            const allInp = [...document.querySelectorAll('input')].filter((n) => n && !n.disabled);
            let pool = allInp.filter((n) => {
              const t = (n.type || 'text').toLowerCase();
              return t !== 'hidden' && !bad(t);
            });
            if (pool.length === 0 && allInp.length === 1) pool = allInp;
            let visible = pool.filter((n) => vis(n));
            let inputs = visible.length ? visible : pool;
            let el = inputs.find((i) => (i.type || '').toLowerCase() === 'search');
            if (!el) {
              el = inputs.find((i) =>
                /search/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || ''))
              );
            }
            if (!el && inputs.length) {
              const sorted = [...inputs].sort(
                (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width
              );
              el = sorted[0];
            }
            if (!el) return false;
            try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
            el.focus();
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.value = q;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
            """,
            query,
        )
        if not ok:
            dbg = driver.execute_script(
                """
                const all = [...document.querySelectorAll('input')];
                const vis = all.filter((n) => n && n.offsetParent !== null && !n.disabled);
                return JSON.stringify({
                  title: document.title || '',
                  inputTotal: all.length,
                  inputVisible: vis.length,
                  href: location.href || '',
                });
                """
            )
            raise RuntimeError(
                "Zepto: search input not found after clicking search bar. "
                f"Debug: {dbg}. Set ZEPTO_BASE_URL to the exact storefront you use."
            )

    time.sleep(0.35)
    try:
        inp2 = _zepto_find_search_input(driver, wait_s=8, require_visible=False)
        inp2.send_keys(Keys.ENTER)
    except Exception:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ENTER)
    time.sleep(3.0)
    try:
        WebDriverWait(driver, wait_s).until(
            lambda d: len(_zepto_product_card_elements(d)) >= 1
            or "showing results" in (d.page_source or "").lower()
            or "results for" in (d.page_source or "").lower()
        )
    except Exception:
        time.sleep(2.5)
    driver.execute_script("window.scrollTo(0, 400);")
    time.sleep(0.6)

    if len(_zepto_product_card_elements(driver)) < 1:
        base = ZEPTO_HOME_URL.rstrip("/")
        for path in (f"/search?query={quote(query)}", f"/search?q={quote(query)}", f"/s?k={quote(query)}"):
            try:
                driver.get(f"{base}{path}")
                time.sleep(3.0)
                if len(_zepto_product_card_elements(driver)) >= 1:
                    break
            except Exception:
                continue


def _zepto_product_link_ok(href: str) -> bool:
    if not href or len(href) < 25:
        return False
    h = href.lower()
    if any(x in h for x in ("/cart", "/login", "/account", "/help", "/terms", "/privacy", "mailto:")):
        return False
    return any(
        x in h
        for x in (
            "/p/",
            "/product",
            "product-detail",
            "/pdp",
            "pdp/",
            "/products/",
            "prd_",
            "itemid",
            "productid",
            "pid=",
            "spid=",
        )
    )


def _zepto_product_card_elements(driver):
    """Collect likely product tiles (anchors + card divs; Zepto URLs vary by region/build)."""
    seen = set()
    out = []

    def take(el):
        try:
            k = id(el)
            if k in seen or not el.is_displayed():
                return
            h = el.rect.get("height", 0)
            w = el.rect.get("width", 0)
            if h < 55 or w < 55 or h > 520:
                return
            blob = (el.text or "")
            if not _zepto_blob_has_price_indicators(blob):
                return
            seen.add(k)
            out.append(el)
        except Exception:
            return

    for css in (
        "a[href*='/p/']",
        "a[href*='/product/']",
        "a[href*='product-detail']",
        "a[href*='product']",
        "a[href*='/PDP/']",
        "a[href*='/products/']",
        "[class*='ProductCard']",
        "[class*='product-card']",
        "[class*='ProductLayout']",
        "[class*='ProductGrid']",
    ):
        for el in driver.find_elements(By.CSS_SELECTOR, css):
            if el.tag_name.lower() == "a":
                href = el.get_attribute("href") or ""
                if not _zepto_product_link_ok(href):
                    continue
            take(el)

    if len(out) < 2:
        for el in driver.find_elements(
            By.XPATH,
            "//a[contains(@href,'http')][.//text()[contains(.,'₹')] or contains(.,'₹') "
            "or contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'rs.')]",
        ):
            href = (el.get_attribute("href") or "").lower()
            if "zepto" not in href and "zeptonow" not in href:
                continue
            if not _zepto_product_link_ok(href) and "/category" not in href:
                if len(href) < 40:
                    continue
            take(el)

    if len(out) < 1:
        for el in driver.find_elements(
            By.XPATH,
            "//*[self::div or self::a][contains(.,'₹') or contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'rs.')]"
            "[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'min')]",
        ):
            take(el)

    return out


def _zepto_pick_grocery_price_per_kg(driver, original_tokens, search_attempt: str) -> float:
    """After navigation/search, parse first plausible grocery card using original ingredient tokens."""
    cards = _zepto_product_card_elements(driver)
    if not cards:
        raise RuntimeError(f"Zepto: no product cards found after search {search_attempt!r}.")

    def _card_query_score(blob: str) -> int:
        b = (blob or "").lower()
        return sum(1 for t in original_tokens if len(t) > 2 and t in b)

    cards = sorted(cards, key=lambda c: _card_query_score(getattr(c, "text", "") or ""), reverse=True)

    rejected = []
    for card in cards[:40]:
        try:
            blob = card.text or ""
        except Exception:
            continue
        title, selling, qty_line = _extract_title_price_qty_from_card_text(blob, original_tokens)
        if selling is None:
            continue
        if not _is_likely_food_grocery(title) or not _is_likely_food_grocery(blob):
            rejected.append(title[:80] if title else "(no title)")
            continue
        blob_l = blob.lower()
        if not _title_matches_ingredient(title, original_tokens) and not any(
            len(t) > 2 and t in blob_l for t in original_tokens
        ):
            rejected.append(title[:80] if title else "(no title)")
            continue
        kg = _quantity_to_kg(qty_line)
        if kg <= 0:
            kg = 0.25
        return round(float(selling) / kg, 2)

    preview = "; ".join(rejected[:6]) if rejected else "(none parsed)"
    raise RuntimeError(
        f"Zepto: no grocery-like match for search {search_attempt!r}. "
        f"Tighten search or extend filters. Skipped samples: {preview}"
    )


def scrape_zepto_ingredient_price_per_kg(driver, normalized_query: str) -> float:
    """
    Search Zepto for the ingredient, pick the first product that looks like grocery food,
    return estimated price_per_kg (INR).
    """
    original_tokens = _ingredient_tokens(normalized_query)
    last_err = None
    for attempt in _zepto_expand_queries(normalized_query):
        try:
            _zepto_run_search(driver, attempt)
            time.sleep(1.5)
            driver.execute_script("window.scrollTo(0, 0);")
            time.sleep(0.4)
            return _zepto_pick_grocery_price_per_kg(driver, original_tokens, attempt)
        except RuntimeError as e:
            last_err = e
            continue
    msg = f"Zepto: could not get a grocery price for {normalized_query!r} after expanded searches."
    if last_err is not None:
        raise RuntimeError(msg) from last_err
    raise RuntimeError(msg)


def fetch_prices_for_ingredient(ingredient_raw):
    """
    Single-ingredient entry used by Node (stdout JSON).
    Opens Zepto, sets location, searches, returns Mongo-shaped prices (Zepto filled; others 0).
    """
    n = normalize_ingredient_name(ingredient_raw)
    if not n:
        raise ValueError("empty ingredient")
    driver = None
    try:
        driver = setup_driver()
        detect_location_zepto(driver)
        time.sleep(3.0)
        zepto_ppk = scrape_zepto_ingredient_price_per_kg(driver, n)
        return {
            "name": n,
            "prices": [
                {"platform": "Blinkit", "price_per_kg": 0.0},
                {"platform": "Zepto", "price_per_kg": zepto_ppk},
                {"platform": "Instamart", "price_per_kg": 0.0},
            ],
            "scrapeMode": "zepto_live",
        }
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass


def setup_driver():
    """
    Edge WebDriver resolution order:
    1) EDGE_DRIVER_PATH or SE_EDGEDRIVER_PATH → local msedgedriver.exe
    2) Selenium Manager (empty Service)
    3) webdriver-manager fallback (network)
    """
    opts = Options()
    
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--user-agent=Mozilla/5.0")
    opts.add_argument(f"--user-data-dir={tempfile.mkdtemp()}")

    env_path = os.getenv("EDGE_DRIVER_PATH") or os.getenv("SE_EDGEDRIVER_PATH")
    if env_path:
        env_path = env_path.strip().strip('"')
        if os.path.isfile(env_path):
            return webdriver.Edge(service=Service(executable_path=env_path), options=opts)
        raise FileNotFoundError(
            f"EDGE_DRIVER_PATH / SE_EDGEDRIVER_PATH is set but not a file: {env_path}"
        )

    try:
        return webdriver.Edge(service=Service(), options=opts)
    except Exception as selenium_err:
        try:
            from webdriver_manager.microsoft import EdgeChromiumDriverManager

            return webdriver.Edge(
                service=Service(EdgeChromiumDriverManager().install()),
                options=opts,
            )
        except Exception as wdm_err:
            wdm_lower = str(wdm_err).lower()
            hint = (
                "Edge WebDriver could not be started.\n"
                "  • Install Microsoft Edge (Chromium).\n"
                "  • Set EDGE_DRIVER_PATH to a local msedgedriver.exe, or fix network/proxy "
                "so Selenium Manager or webdriver-manager can download a matching driver.\n"
                "  • 'Could not reach host' / URLError usually means a blocked driver download, "
                "not the storefront itself.\n"
            )
            raise RuntimeError(
                f"{hint}Selenium: {selenium_err}\nwebdriver-manager: {wdm_err}"
            ) from (
                wdm_err if "offline" in wdm_lower or "could not reach" in wdm_lower else selenium_err
            )


def _js_click(driver, element):
    driver.execute_script(
        "arguments[0].scrollIntoView({block:'center', inline:'center'});", element
    )
    time.sleep(0.2)
    driver.execute_script("arguments[0].click();", element)


def _click_zepto_use_my_current_location(driver, wait_s=25):
    """
    Zepto renders this row in different wrappers (div/button, nested spans).
    Native .click() often fails (overlay / pointer-events); use JS click on sensible candidates.
    """
    end = time.time() + wait_s
    needle = "use my current location"

    while time.time() < end:
        candidates = []
        for el in driver.find_elements(
            By.XPATH,
            "//*[@aria-label and contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'use my current location')]"
            " | //button[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'use my current location')]"
            " | //*[@role='button'][contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'use my current location')]"
            " | //div[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'use my current location')]"
            " | //span[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'use my current location')]",
        ):
            try:
                if not el.is_displayed():
                    continue
                t = (el.text or "").strip().lower()
                if needle not in t and needle not in (el.get_attribute("aria-label") or "").lower():
                    continue
                r = el.rect
                h, w = r.get("height", 0), r.get("width", 0)
                area = h * w
                # Skip junk / full-viewport wrappers; keep row-sized controls
                if area < 500 or h < 28 or w < 80:
                    continue
                if h > 400 or w > driver.execute_script("return window.innerWidth || 800"):
                    continue
                candidates.append((area, el))
            except Exception:
                continue

        candidates.sort(key=lambda x: x[0])
        for _area, el in candidates:
            try:
                _js_click(driver, el)
                time.sleep(1.0)
                return
            except Exception:
                continue

        time.sleep(0.4)

    raise TimeoutError(
        "Could not activate 'Use My Current Location' (no matching clickable node). "
        "Try ZEPTO_BASE_URL=https://www.zeptonow.com/ if you use the India storefront."
    )


def detect_location_zepto(driver, wait_s=20):
    """
    Zepto: header 'Select Location' → modal → click 'Use My Current Location' row/card.

    Geolocation may prompt the OS/browser; non-headless is more reliable than headless.
    """
    wait = WebDriverWait(driver, wait_s)
    driver.get(ZEPTO_HOME_URL)

    # Header control: often a button or role="button" with visible text "Select Location"
    select_loc = wait.until(
        EC.element_to_be_clickable(
            (
                By.XPATH,
                "//button[contains(., 'Select Location')]"
                " | //*[@role='button'][contains(., 'Select Location')]"
                " | //*[@aria-label and contains(@aria-label, 'Select Location')]",
            )
        )
    )
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", select_loc)
    time.sleep(0.3)
    select_loc.click()

    wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(.,'Your Location')]")))
    time.sleep(1.2)

    _click_zepto_use_my_current_location(driver, wait_s=wait_s)

    print("[Zepto] Select Location -> Use My Current Location clicked.")
    time.sleep(3.0)


def real_scrape_and_store():
    """Browser preflight: Zepto location (works where Blinkit blocks automation)."""
    driver = None
    try:
        driver = setup_driver()
        detect_location_zepto(driver)
        print("[Zepto] Location OK. Full search+parse runs on --single <ingredient> from the API.")
    except Exception as e:
        print(f"[Zepto] Browser preflight failed: {e}")
        raise
    finally:
        if driver:
            driver.quit()


def main():
    """CLI: optional local browser smoke test (does not call Mongo)."""
    print("[scraper] Live scraper: browser preflight only (ingredient prices via --single from API)\n")
    real_scrape_and_store()
    print("\n[scraper] Preflight done.")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--single":
        try:
            raw = sys.argv[2]
            doc = fetch_prices_for_ingredient(raw)
            print(json.dumps(doc))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)

    try:
        main()
    except Exception as e:
        print(f"\n[scraper] Fatal error: {e}")
        sys.exit(1)
