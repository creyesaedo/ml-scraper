# Database Reference

Schema definido en [prisma/schema.prisma](prisma/schema.prisma). Cuatro tablas: `categories`, `products`, `sellers`, `sync_progress`.

---

## Diagrama de relaciones

```
┌─────────────┐         ┌───────────┐         ┌─────────────┐
│ categories  │         │ products  │         │   sellers   │
│             │         │           │         │             │
│ id (PK)     │◄────┐   │ id (PK)   │   ┌────►│ id (PK)     │
│ parent_id   │─┐   ├───┤ category_id│   │     │ ...         │
│ ...         │ │   │   │ parent_id  │───┘     └─────────────┘
└─────────────┘ │   │   │ seller_id  │
                │   │   │ ...        │
                │   │   └────────────┘
                │   │
                └───┘  self-FK (Category.parent_id → Category.id)
```

- Una `Category` puede tener un `parent` (otra `Category`) — árbol de 2 niveles (raíz → hoja).
- Un `Product` referencia su `category` (hoja cuando se resolvió) y su `parent_category` (raíz).
- Un `Product` puede referenciar un `Seller`.
- Un `Seller` puede tener muchos `Product` (un producto por snapshot).

---

## Tabla `categories`

Categorías de MercadoLibre. Las raíces vienen del endpoint oficial `/sites/{siteId}/categories`. Las hojas se crean durante el scraping de productos cuando aparecen en el breadcrumb.

| Columna | Tipo | Nullable | Descripción | Ejemplo |
|---|---|---|---|---|
| `id` | `int` (autoincrement) | NO | Clave primaria interna | `42` |
| `name` | `varchar(255)` | NO | Nombre legible de la categoría | `"Herramientas"` |
| `country` | `varchar(10)` | NO | Código de país de ML donde existe esta categoría | `"MLC"`, `"MLA"`, `"MLB"` |
| `ml_id` | `varchar(50)` UNIQUE | NO | ID de MercadoLibre. Único globalmente (los IDs incluyen el prefijo del país) | `"MLC1574"`, `"MLA1051"` |
| `parent_id` | `int` | **SÍ** | FK a `categories.id`. NULL = categoría raíz. No-null = categoría hoja, apunta a su raíz | `12` o `null` |

**Índices:**
- `ml_id` (único) — lookup por ID de ML.
- `country` — listar todas las categorías de un país.
- `parent_id` — listar todas las hojas de una raíz.

**Notas:**
- El árbol es **de profundidad fija = 2** (raíz → hoja). No hay sub-sub-categorías.
- Solo se crean hojas que aparecen en productos scrapeados — no todas las hojas existentes en ML están en la DB.

---

## Tabla `products`

**Snapshots inmutables** de productos top-vendidos. Cada corrida del sync inserta filas nuevas — no se sobreescriben. Esto permite reconstruir histórico de precios, rankings y reviews por fecha.

### Campos básicos del producto

| Columna | Tipo | Nullable | Descripción | Ejemplo |
|---|---|---|---|---|
| `id` | `int` (autoincrement) | NO | Clave primaria | `54321` |
| `name` | `varchar(500)` | NO | Título del producto como aparece en ML | `"Gata Hidráulica Tasbel 2 Toneladas"` |
| `price` | `decimal(14, 2)` | NO | Precio en moneda local (sin símbolo, sin separadores de miles, con "country" despues se hace el formato regional) | `44390.00` |
| `country` | `varchar(10)` | SÍ | Código del site de ML (redundante con `category.country` pero útil para filtros sin JOIN) | `"MLC"` |
| `snapshot_date` | `timestamp` | NO (default `now()`) | Momento del snapshot. Misma fecha en todas las filas de un mismo sync | `2026-05-23 06:43:06` |

### Campos de categorización

| Columna | Tipo | Nullable | Descripción |
|---|---|---|---|
| `category_id` | `int` | NO | FK a `categories.id`. Apunta a la **categoría hoja** cuando se pudo resolver el breadcrumb Nav(El de la pagina web de ML). Si no se resolvió, apunta a la raíz |
| `parent_id` | `int` | SÍ | FK a `categories.id`. Apunta a la **raíz** cuando `category_id` es una hoja. NULL cuando `category_id` ya ES la raíz (no se pudo resolver hoja) |

**Lógica**:
- Si scraper extrajo `categoryId` del breadcrumb → `category_id = leaf`, `parent_id = root`.
- Si no se pudo resolver → `category_id = root`, `parent_id = NULL`.

**Para "todos los productos de la raíz X"**: `WHERE category_id = X OR parent_id = X`.

### Campos de identidad y vendedor

| Columna | Tipo | Nullable | Descripción | Ejemplo |
|---|---|---|---|---|
| `catalog_id` | `varchar(50)` | SÍ | ID del **producto-concepto** en el catálogo de ML. NULL para productos sin página de catálogo (URLs `/up/`) | `"MLC47591525"` |
| `seller_id` | `int` | SÍ | FK a `sellers.id`. NULL si no se pudo extraer el vendedor del HTML | `7` |

### Campos de enriquecimiento (del HTML del producto + API de ML)

| Columna | Tipo | Nullable | Descripción | Ejemplo |
|---|---|---|---|---|
| `date_created` | `timestamp` | SÍ | Fecha en que se creó el catálogo del producto. Viene del API `/products/{catalog_id}` cuando hay `catalog_id`, o del HTML como fallback | `2024-01-15 10:30:00` |
| `sold_count` | `int` | SÍ | Cantidad aproximada de ventas del catálogo. Parseado del badge "+X mil vendidos". Es un **piso** (la cifra real es ≥) | `10000` |
| `rating` | `decimal(3, 2)` | SÍ | Rating promedio del catálogo (0–5) | `4.80` |
| `review_count` | `int` | SÍ | Número de reviews del catálogo | `342` |
| `brand` | `varchar(255)` | SÍ | Marca declarada en los atributos del producto | `"Apple"`, `"Tasbel"` |

### Campos de market analysis (extraídos del HTML de la página de más vendidos / PDP)

| Columna | Tipo | Nullable | Descripción | Ejemplo |
|---|---|---|---|---|
| `ranking_position` | `int` | SÍ | Posición del producto en la página de **más vendidos** de su categoría raíz al momento del snapshot. 1 = primero. Permite tracking de subidas/bajadas semana a semana | `1`, `17` |
| `original_price` | `decimal(14, 2)` | SÍ | Precio **antes** del descuento (`previous_price.value` en el buy-box del PDP). NULL cuando el producto no tiene descuento activo | `32990.00` |
| `discount_pct` | `int` | SÍ | Porcentaje de descuento visible en el buy-box. NULL cuando no hay descuento. Rango válido: 1–100 | `34` |
| `shipping_type` | `varchar(20)` | SÍ | Tipo de logística del listing ganador del buy-box. Valores: `"full"` (almacén ML), `"cross_border"` (importado, internacional), `"free"` (envío gratis sin FULL), `"standard"` (con costo). NULL si no se pudo detectar | `"full"` |
| `listing_type_id` | `varchar(20)` | SÍ | Tier de publicación que el vendedor contrató con ML. Valores típicos: `"gold_pro"` (Premium, máx exposición + cuotas sin interés), `"gold_special"` (Clásica), `"gold"`, `"free"`. Proxy de inversión publicitaria del vendedor | `"gold_pro"` |
| `is_cbt` | `boolean` | NO (default `false`) | `true` si el listing ganador es **cross-border / internacional** (producto importado vía CBT). Detectado por la presencia del bloque `cbt_summary` o el icono `cbt_fsbar_airplane` en el HTML | `true` |

**Índices:**
- `category_id`, `parent_id` — joins con categories.
- `snapshot_date` — filtrar por fecha del snapshot.
- `(country, snapshot_date)` — "top de país X en fecha Y" (compuesto, muy usado).
- `(catalog_id, snapshot_date)` — "historia del producto X" (series de tiempo).
- `seller_id` — productos de un vendedor.

**Notas sobre los campos de market analysis:**
- `ranking_position` se setea desde el índice de aparición en la página `/mas-vendidos/{id}` de la **categoría raíz**. Cuando `category_id` apunta a una hoja, el ranking sigue siendo el de la raíz (es la única página que ML expone como ranking).
- `original_price` y `discount_pct` vienen siempre juntos: si uno es NULL, el otro también lo es. Cuando `discount_pct = 0`, ML omite el bloque y ambos quedan NULL.
- `shipping_type = "full"` implica que ML maneja el stock — fuerte señal de profesionalización del vendedor.
- `is_cbt = true` y `shipping_type = "cross_border"` suelen coincidir, pero no son el mismo campo: `is_cbt` mira el origen del producto, `shipping_type` mira la logística. Pueden divergir en CBT con stock en bodega local.

---

## Tabla `sellers`

Vendedores con su metadata actual. **Mutable**: se hace UPSERT en cada sync, sobrescribe nickname/status/totales (overwrite latest, no SCD-2).

| Columna | Tipo | Nullable | Descripción | Ejemplo |
|---|---|---|---|---|
| `id` | `int` (autoincrement) | NO | Clave primaria interna | `7` |
| `ml_seller_id` | `varchar(50)` UNIQUE | NO | ID numérico del vendedor en ML. Único globalmente | `"818179326"` |
| `nickname` | `varchar(255)` | SÍ | Nombre público del vendedor | `"LH PET SHOP"`, `"COMERCIALIZADORA-45-..."` |
| `is_official_store` | `boolean` | NO (default `false`) | `true` si la página muestra "Tienda Oficial" (en vez del nickname normal) | `true` |
| `power_seller_status` | `varchar(50)` | SÍ | Nivel de MercadoLíder, en minúsculas. Valores típicos: `"platinum"`, `"gold"`, `"silver"`, `"mercadolider"`, `null` (sin badge) | `"platinum"` |
| `total_products` | `int` | SÍ | Cantidad aproximada de productos publicados por el vendedor. Parseado del badge "+N Productos". Es un **piso** | `1000` |
| `total_sales` | `int` | SÍ | Cantidad aproximada de ventas totales del vendedor. Parseado del badge "+N Ventas" (acepta "mil" y "millón"). Es un **piso** | `250000` |
| `country` | `varchar(10)` | SÍ | Site de ML donde se vio por primera vez al vendedor (un vendedor puede operar en múltiples países; aquí se guarda solo el primero observado) | `"MLC"` |
| `first_seen` | `timestamp` | NO (default `now()`) | Cuándo se vio al vendedor por primera vez en nuestros snapshots | `2026-05-23 06:43:06` |
| `last_seen` | `timestamp` | NO (default `now()`) | Última corrida del sync en la que apareció. Útil para detectar vendedores "inactivos" | `2026-05-23 06:43:06` |

**Índices:**
- `ml_seller_id` (único) — lookup por ID de ML.
- `country` — vendedores por país.
- `power_seller_status` — filtrar por nivel (ej. solo Platinum).

**Notas importantes:**
- Los valores "+N" en ML están redondeados hacia abajo. Guardamos el **piso**, no el dato exacto.
- `is_official_store=true` y un `nickname` raro (ej. `"COMERCIALIZADORA-45-..."`) coexisten: cuando ML detecta tienda oficial, oculta el nickname personal y muestra el nombre de la tienda en otro bloque (que hoy no extraemos como campo separado).

---

## Patrones de consulta comunes

### Top 10 productos más vendidos de Chile en el último snapshot

```sql
SELECT p.name, p.price, s.nickname AS vendedor, p.sold_count
FROM products p
LEFT JOIN sellers s ON p.seller_id = s.id
WHERE p.country = 'MLC'
  AND p.snapshot_date = (SELECT MAX(snapshot_date) FROM products WHERE country = 'MLC')
ORDER BY p.sold_count DESC NULLS LAST
LIMIT 10;
```

### Historia de precio de un producto específico

```sql
SELECT snapshot_date, price, sold_count, rating
FROM products
WHERE catalog_id = 'MLC47591525'
ORDER BY snapshot_date;
```

### Vendedores más fuertes en una raíz de categoría

```sql
SELECT s.nickname, s.power_seller_status, COUNT(*) AS productos_top
FROM products p
JOIN sellers s ON p.seller_id = s.id
WHERE p.country = 'MLC'
  AND (p.category_id = 335 OR p.parent_id = 335)
  AND p.snapshot_date = (SELECT MAX(snapshot_date) FROM products WHERE country = 'MLC')
GROUP BY s.id, s.nickname, s.power_seller_status
ORDER BY productos_top DESC;
```

### Comparativa de penetración de Tiendas Oficiales por país

```sql
SELECT
  p.country,
  COUNT(*) FILTER (WHERE s.is_official_store) * 100.0 / COUNT(*) AS pct_tienda_oficial
FROM products p
JOIN sellers s ON p.seller_id = s.id
WHERE p.snapshot_date = (SELECT MAX(snapshot_date) FROM products p2 WHERE p2.country = p.country)
GROUP BY p.country
ORDER BY pct_tienda_oficial DESC;
```

### Vendedores nuevos en el último mes

```sql
SELECT nickname, country, power_seller_status, total_sales
FROM sellers
WHERE first_seen >= NOW() - INTERVAL '30 days'
ORDER BY total_sales DESC NULLS LAST;
```

---

## Tabla `sync_progress`

Checkpoint **por categoría** de cada corrida del sync. Permite (a) saber en qué punto se cayó un sync, (b) retomar lo que faltaba sin re-scrapear lo que ya se hizo. La pobla y mantiene `ProductCollectionService`.

| Columna | Tipo | Nullable | Descripción | Ejemplo |
|---|---|---|---|---|
| `id` | `int` (autoincrement) | NO | Clave primaria | `123` |
| `sync_run_id` | `varchar(100)` | NO | ID estable de la corrida. Formato: `{siteId}-{ISO-timestamp con `:` y `.` reemplazados}` | `"MLC-2026-05-23T03-00-00-000Z"` |
| `country` | `varchar(10)` | NO | Site al que pertenece esta categoría | `"MLC"` |
| `category_ml_id` | `varchar(50)` | NO | ML ID de la categoría raíz que se está scrapeando | `"MLC1512"` |
| `status` | `varchar(20)` | NO | `"pending"` \| `"in_progress"` \| `"done"` \| `"failed"` | `"done"` |
| `error_msg` | `text` | SÍ | Mensaje de error truncado a 1000 chars cuando `status = "failed"` | `"Tripped after 10 consecutive failures..."` |
| `started_at` | `timestamp` | SÍ | Cuándo arrancó esta categoría (NULL hasta que pasa a `in_progress`) | `2026-05-23 03:00:14` |
| `completed_at` | `timestamp` | SÍ | Cuándo terminó (done o failed) | `2026-05-23 03:01:02` |
| `created_at` | `timestamp` | NO (default `now()`) | Cuándo se creó el row (al abrir el sync_run) | `2026-05-23 03:00:00` |

**Constraints e índices:**
- `UNIQUE(sync_run_id, category_ml_id)` — un sync_run no puede tener dos filas para la misma categoría.
- `INDEX(country, status)` — para queries "qué quedó pendiente en este país".
- `INDEX(sync_run_id)` — para queries "todo el progreso de esta corrida".

**Ciclo de vida:**
1. `openSyncRun()` inserta una fila por categoría con `status = "pending"`.
2. Al empezar cada categoría → `status = "in_progress"`, `started_at = now()`.
3. Si termina bien → `status = "done"`, `completed_at = now()`.
4. Si falla (excepción NO relacionada al circuit breaker) → `status = "failed"`, `error_msg`, `completed_at`. El sync continúa con las demás categorías.
5. Si el **circuit breaker** dispara → la categoría in-flight se marca `failed`, las que aún estaban `pending` quedan así, y `collect()` retorna con `aborted` poblado en la respuesta. Las nuevas no arrancan.

**Resume (`POST /sync/resume/:siteId`):**
- Busca el `sync_run_id` más reciente con alguna fila en estado `pending`, `in_progress` o `failed` para ese país.
- Resetea `in_progress`/`failed` → `pending` (las vuelve a intentar).
- Conserva `done` y las salta en el loop.

**Queries útiles:**

```sql
-- ¿Cómo va la corrida actual?
SELECT status, COUNT(*) FROM sync_progress
WHERE sync_run_id = 'MLC-2026-05-23T03-00-00-000Z' GROUP BY status;

-- Últimas categorías que fallaron, con el motivo
SELECT category_ml_id, error_msg, completed_at FROM sync_progress
WHERE country = 'MLC' AND status = 'failed'
ORDER BY completed_at DESC LIMIT 10;

-- Tiempo promedio por categoría en el último sync exitoso
SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) AS avg_secs
FROM sync_progress
WHERE sync_run_id = (
  SELECT sync_run_id FROM sync_progress
  WHERE country = 'MLC' AND status = 'done'
  ORDER BY completed_at DESC LIMIT 1
) AND status = 'done';
```

---

## Convenciones del schema

- **Nombres en inglés**: todas las columnas (no hay mezcla con español).
- **Mapping**: las tablas usan `@@map("nombre_plural")` para que el nombre físico sea el plural (`categories`, `products`, `sellers`).
- **Soft enrichment**: todos los campos enriquecidos (sold_count, rating, brand, etc.) son nullables — un producto puede guardarse aunque alguna fuente falle.
- **Inmutabilidad de products**: nunca se actualiza una fila de `products`, solo se inserta. Para "última versión" del catálogo, filtrar por `snapshot_date = MAX(...)`.
- **Mutabilidad de sellers**: la fila se actualiza en cada sync. Si querés historial del vendedor, habría que agregar una `seller_snapshots` separada (no está implementado).
