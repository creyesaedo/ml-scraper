# Database Reference

Schema definido en [prisma/schema.prisma](prisma/schema.prisma). Cuatro tablas: `categories`, `products`, `sellers`, `sync_progress`.

Cada tabla lista todas sus columnas con dos lentes: **qué dato representa** (lo que es del lado de MercadoLibre) y **valor para market analysis** (por qué la guardamos y qué pregunta de negocio responde).

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

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `id` | `int` PK | NO | Clave primaria interna autoincremental. | Infraestructural — sirve para joins rápidos y como FK desde `products.category_id` / `products.parent_id`. |
| `name` | `varchar(255)` | NO | Nombre legible de la categoría tal como aparece en ML (ej. `"Herramientas"`, `"Celulares y Teléfonos"`). | Es el label humano de cualquier reporte agregado por categoría — sin él los IDs no se entienden. |
| `country` | `varchar(10)` | NO | Site de ML donde existe esta categoría (`"MLC"`, `"MLA"`, `"MLB"`, ...). | Permite comparar la misma vertical entre países (ej. "Herramientas Chile vs Argentina") sin mezclar IDs. |
| `ml_id` | `varchar(50)` UNIQUE | NO | ID de MercadoLibre. Único global (lleva el prefijo del país, ej. `"MLC1574"`, `"MLA1051"`). | Es la única clave estable contra ML: permite reabrir la URL de la categoría, llamar la API oficial y deduplicar entre runs. |
| `parent_id` | `int` FK | SÍ | FK a `categories.id`. NULL = categoría raíz. No-null = hoja, apunta a su raíz. | Define el árbol de 2 niveles — permite reportar tanto "top de la raíz Herramientas" como "top de la hoja Sierras eléctricas" sin duplicar datos. |

**Índices:**
- `ml_id` (único) — lookup por ID de ML.
- `country` — listar todas las categorías de un país.
- `parent_id` — listar todas las hojas de una raíz.

**Notas:**
- El árbol es de **profundidad fija = 2** (raíz → hoja). No hay sub-sub-categorías.
- Solo se crean hojas que aparecen en productos scrapeados — no todas las hojas existentes en ML están en la DB.

---

## Tabla `products`

**Snapshots inmutables** de productos top-vendidos. Cada corrida del sync inserta filas nuevas — no se sobreescriben. Esto permite reconstruir histórico de precios, rankings y reviews por fecha.

### Campos básicos del producto

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `id` | `int` PK | NO | Clave primaria interna autoincremental. | Infraestructural — identifica unívocamente cada snapshot fila para joins. |
| `name` | `varchar(500)` | NO | Título del producto como aparece en ML (ej. `"Gata Hidráulica Tasbel 2 Toneladas"`). | Permite búsquedas léxicas, agrupación por keywords, y detección de cambios de naming (rebrand, edición especial). |
| `price` | `decimal(14, 2)` | NO | Precio en moneda local del país (sin símbolo, sin separadores de miles; el formateo se hace por `country` en la capa de presentación). Ej. `44390.00`. | Métrica central para tracking de precios, elasticidad, comparativas competitivas y detección de promos. |
| `country` | `varchar(10)` | SÍ | Código del site de ML (redundante con `category.country` pero permite filtrar sin JOIN). | Acelera dashboards y queries cross-country sin pagar el costo del JOIN a `categories`. |
| `snapshot_date` | `timestamp` | NO (default `now()`) | Momento del snapshot. Misma fecha en todas las filas de una misma corrida del sync. | Es el eje temporal — sin él no hay análisis longitudinal. Toda serie de tiempo (precio, ranking, reviews) se construye sobre este campo. |

### Campos de categorización

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `category_id` | `int` FK | NO | FK a `categories.id`. Apunta a la **hoja** cuando se pudo resolver el breadcrumb del PDP. Si no, apunta a la raíz. | Permite slicing fino: market share por vertical específica (ej. "Sierras inalámbricas") en vez de solo por categoría grande. |
| `parent_id` | `int` FK | SÍ | FK a `categories.id`. Apunta a la **raíz** cuando `category_id` es hoja. NULL cuando `category_id` ya ES la raíz. | Permite agregar al nivel de raíz sin necesidad de subir el árbol con un JOIN recursivo: `WHERE category_id = X OR parent_id = X`. |

**Lógica**:
- Si scraper extrajo `categoryId` del breadcrumb → `category_id = leaf`, `parent_id = root`.
- Si no se pudo resolver → `category_id = root`, `parent_id = NULL`.

### Campos de identidad y vendedor

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `catalog_id` | `varchar(50)` | SÍ | ID del **producto-concepto** en el catálogo de ML (mismo producto compartido por múltiples vendedores en el buy-box). NULL para listings `/up/` sin catálogo. | Permite seguir un producto a lo largo del tiempo aunque cambie el vendedor del buy-box, y agregar metadata via API `/products/{catalog_id}`. Es la clave para series de tiempo product-level. |
| `ml_public_id` | `varchar(50)` | SÍ | ID de la **publicación específica** (listing) que ganó el buy-box, parseado del bloque "Publicación #NNNNNN" del PDP. Distinto de `catalog_id` — identifica la oferta puntual del vendedor. | Permite reconstruir la URL canónica del listing, deduplicar publicaciones del mismo vendedor y trackear cuándo un mismo `catalog_id` cambia de listing ganador (rotación de buy-box). |
| `seller_id` | `int` FK | SÍ | FK a `sellers.id`. NULL si no se pudo extraer el vendedor del HTML. | Permite cruzar producto ↔ vendedor para responder "qué vendedores dominan la categoría", "cuál es la fuerza de un seller", "share de Tiendas Oficiales", etc. |

### Campos de enriquecimiento (HTML del PDP + API de ML)

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `date_created` | `timestamp` | SÍ | Fecha en que se creó el catálogo del producto. Viene del API `/products/{catalog_id}` cuando hay `catalog_id`; fallback al HTML. | Permite medir la **edad del producto** en el top: ¿están dominando lanzamientos recientes o productos legacy? Útil para detectar refresh-rate de catálogos por vertical. |
| `sold_count` | `int` | SÍ | Cantidad aproximada de ventas históricas del catálogo. Parseado del badge "+X mil/millón vendidos" del PDP. Es un **piso** (la cifra real es ≥). | Único proxy de volumen disponible (la API no lo expone). Ranking complementario al de top-sellers, y delta semanal aproxima velocidad de venta. |
| `rating` | `decimal(3, 2)` | SÍ | Rating promedio (0–5) del catálogo en ML. | Indicador de calidad percibida — cruza con `discount_pct` para detectar "barato pero malo", o con `power_seller_status` para validar vendedores. |
| `review_count` | `int` | SÍ | Número total de reviews del catálogo. | Indica madurez y volumen del producto. Un rating de 4.9 con 5 reviews vs 4.5 con 5000 son señales muy distintas — sin este campo el rating es engañoso. |
| `brand` | `varchar(255)` | SÍ | Marca declarada en los atributos del producto (ej. `"Apple"`, `"Tasbel"`). | Permite agregaciones por marca (market share, premium-precio promedio, presencia en top-N), detectar dominancia de marcas chinas/blancas y benchmarking competitivo. |
| `holiday_name` | `varchar(255)` | SÍ | Nombre del feriado nacional (ISO inglés, vía API `date.nager.at`) si `snapshot_date` cae exactamente en un feriado del país del site. NULL en días normales. | Permite filtrar/excluir snapshots de fechas atípicas (lunes feriado vs lunes común) y aislar el efecto de feriados sobre precios y rankings. Útil para no contaminar baselines. |

### Campos de market analysis (HTML de más vendidos / PDP)

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `ranking_position` | `int` | SÍ | Posición del producto en la página `/mas-vendidos/{root_id}` al momento del snapshot. 1 = primero, 20 = último. Siempre del ranking de la **raíz** (es la única que ML expone). | Métrica de visibilidad: subir/bajar puestos semana a semana mide momentum. Permite identificar nuevos entrantes al top y productos que están perdiendo terreno. |
| `original_price` | `decimal(14, 2)` | SÍ | Precio antes del descuento (`previous_price.value` en el buy-box). NULL cuando el producto no tiene descuento activo. | Junto con `price` permite calcular el descuento absoluto y detectar "falsos descuentos" (precio inflado antes de promo). Base para análisis de pricing dinámico. |
| `discount_pct` | `int` | SÍ | Porcentaje de descuento que ML muestra en el buy-box (1–100). NULL cuando no hay descuento. | Mide intensidad promocional por categoría / país. Permite contestar "qué % del top está en oferta", "cuán agresivo descuenta una marca", o detectar Cyber-events sin saberlo de antemano. |
| `shipping_type` | `varchar(20)` | SÍ | Tipo logístico del listing ganador. Valores: `"full"` (FULL, almacén ML), `"cross_border"` (importado), `"free"` (gratis sin FULL), `"standard"` (con costo). | Indicador de profesionalización del seller y experiencia del comprador. `full` correlaciona con velocidad y conversión más altas; cross-border señala dependencia de importación. |
| `listing_type_id` | `varchar(20)` | SÍ | Tier de publicación contratado: `"gold_pro"` (Premium, máx exposición + cuotas), `"gold_special"` (Clásica), `"gold"`, `"free"`. | Proxy de inversión publicitaria del vendedor. Permite estimar cuánto "paga" un seller para mantenerse en el top y modelar barreras de entrada por categoría. |
| `is_cbt` | `boolean` | NO (default `false`) | `true` si el listing ganador es **cross-border / internacional** (CBT). Detectado por bloque `cbt_summary` o icono `cbt_fsbar_airplane`. | Mide penetración de importadores vs locales en el top. Crítico para verticales (electrónica, fashion) donde el CBT redefine la competencia local. |

### Campos de conversión a dólares (FX)

Calculados al momento del snapshot con la tasa USD del día (API `open.er-api.com`). La tasa se resuelve **una vez por corrida y por sitio** (cada sitio tiene una sola moneda) y se aplica a todas las filas de esa corrida. Si la API de tasas falla, `currency` igual se guarda pero `exchange_rate` / `usd_price` / `usd_original_price` quedan en NULL y el sync continúa (fallo suave — no aborta).

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `currency` | `varchar(3)` | SÍ | Código ISO 4217 de la **moneda local** del site (`"CLP"`, `"ARS"`, `"BRL"`, ... `"USD"` para Ecuador). Derivado del siteId vía `SITE_CURRENCIES`. NULL si el site no está mapeado. | Hace cada snapshot autoexplicativo: `country` guarda el siteId, no la moneda. Sin esto, un `price` crudo no se sabe en qué divisa está. Indispensable para comparar/convertir entre países. |
| `exchange_rate` | `decimal(18, 8)` | SÍ | Tasa exacta usada en el snapshot: **unidades locales por 1 USD** (ej. `950.50000000` = 1 USD vale 950.5 CLP). NULL si no se pudo obtener. | Como los snapshots son inmutables, guardar la tasa hace la conversión **reproducible y auditable**: permite recalcular o corregir los valores USD sin re-scrapear, y analizar la evolución del tipo de cambio. |
| `usd_price` | `decimal(14, 2)` | SÍ | `price` convertido a dólares (`price / exchange_rate`). Para Ecuador (tasa 1) `usd_price === price`. NULL si no hubo tasa. | Objetivo principal: permite comparar precios de productos entre los 10 países en una unidad común, sin que distorsionen las diferencias de moneda. |
| `usd_original_price` | `decimal(14, 2)` | SÍ | `original_price` (precio antes del descuento) convertido a dólares con la misma tasa. NULL cuando no hay descuento o no hubo tasa. | Complementa a `usd_price`: permite medir el descuento absoluto en USD y comparar la profundidad de ofertas entre países en una misma unidad. |

**Índices:**
- `category_id`, `parent_id` — joins con categories.
- `snapshot_date` — filtrar por fecha del snapshot.
- `(country, snapshot_date)` — "top de país X en fecha Y" (compuesto, muy usado).
- `(catalog_id, snapshot_date)` — "historia del producto X" (series de tiempo).
- `seller_id` — productos de un vendedor.

**Notas sobre los campos de market analysis:**
- `ranking_position` se setea desde el índice de aparición en `/mas-vendidos/{root}`. Aunque el producto se asocie a una hoja vía `category_id`, su ranking sigue siendo el de la raíz.
- `original_price` y `discount_pct` vienen siempre juntos: si uno es NULL, el otro también lo es.
- `shipping_type = "full"` implica que ML maneja el stock — fuerte señal de profesionalización.
- `is_cbt = true` y `shipping_type = "cross_border"` suelen coincidir pero no son lo mismo: `is_cbt` mira el **origen** del producto, `shipping_type` mira la **logística**. Pueden divergir en CBT con stock en bodega local.

---

## Tabla `sellers`

Vendedores con su metadata actual. **Mutable**: se hace UPSERT en cada sync, sobrescribe nickname/status/totales (overwrite latest, no SCD-2).

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `id` | `int` PK | NO | Clave primaria interna autoincremental. | Infraestructural — FK desde `products.seller_id`. |
| `ml_seller_id` | `varchar(50)` UNIQUE | NO | ID numérico del vendedor en ML, único globalmente (ej. `"818179326"`). | Clave estable contra ML: permite reabrir el perfil público, llamar la API oficial de users/items y deduplicar el mismo vendedor entre runs y entre países. |
| `nickname` | `varchar(255)` | SÍ | Nombre público del vendedor (ej. `"LH PET SHOP"`, `"COMERCIALIZADORA-45-..."`). | Label legible para reportes — sin él el `ml_seller_id` es opaco. Ojo: cambia cuando el vendedor lo renombra. |
| `is_official_store` | `boolean` | NO (default `false`) | `true` si ML marca al vendedor como "Tienda Oficial" (perfil distinto del seller común). | Métrica clave de profesionalización: permite separar "presencia de marca oficial" vs "reseller". Cross-country muestra qué marcas invirtieron en su canal directo. |
| `power_seller_status` | `varchar(50)` | SÍ | Nivel de MercadoLíder en minúsculas: `"platinum"`, `"gold"`, `"silver"`, `"mercadolider"`, NULL (sin badge). | Indicador de confianza y volumen avalado por ML. Filtrar por Platinum aísla al top operativo; ausencia de badge señala vendedores nuevos o con problemas de reputación. |
| `total_products` | `int` | SÍ | Cantidad aproximada de productos publicados (parseado del badge "+N Productos"). Es un **piso**. | Tamaño del catálogo — distingue seller boutique vs marketplace operator. Combina con `total_sales` para estimar productos-activos vs long-tail muerta. |
| `total_sales` | `int` | SÍ | Cantidad aproximada de ventas históricas totales (badge "+N Ventas", acepta "mil"/"millón"). Es un **piso**. | Proxy del tamaño operativo total del vendedor (todas las categorías). Permite ranking de top-sellers globales y estimación de market share absoluta. |
| `country` | `varchar(10)` | SÍ | Site de ML donde se vio al vendedor por primera vez (un mismo seller puede operar en varios países; guardamos solo el primero observado). | Permite segmentar vendedores por mercado de origen — útil para preguntas como "qué % de los top-sellers en MLM también juegan en MLC". |
| `first_seen` | `timestamp` | NO (default `now()`) | Cuándo entró el vendedor a nuestros snapshots. | Detecta vendedores **nuevos** en el top (entrada al mercado relevante), no la edad real del seller en ML. |
| `last_seen` | `timestamp` | NO (default `now()`) | Última corrida del sync donde apareció. | Detecta vendedores que **salieron** del top o desaparecieron (churn). `now() - last_seen > 30d` ≈ inactivo en el ranking. |

**Índices:**
- `ml_seller_id` (único) — lookup por ID de ML.
- `country` — vendedores por país.
- `power_seller_status` — filtrar por nivel (ej. solo Platinum).

**Notas importantes:**
- Los valores "+N" en ML están redondeados hacia abajo. Guardamos el **piso**, no el dato exacto.
- `is_official_store=true` y un `nickname` raro (ej. `"COMERCIALIZADORA-45-..."`) coexisten: cuando ML detecta tienda oficial, oculta el nickname personal y muestra el nombre de la tienda en otro bloque (hoy no extraído como campo separado).
- Como la tabla es **mutable**, no podés reconstruir el `power_seller_status` que tenía un vendedor hace 3 meses. Si necesitás historial de seller, hay que agregar una `seller_snapshots` (no implementado).

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
SELECT snapshot_date, price, original_price, discount_pct, ranking_position
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

### Intensidad promocional por categoría (Chile, último snapshot)

```sql
SELECT c.name AS categoria,
       COUNT(*) FILTER (WHERE p.discount_pct IS NOT NULL) * 100.0 / COUNT(*) AS pct_en_oferta,
       AVG(p.discount_pct) FILTER (WHERE p.discount_pct IS NOT NULL) AS descuento_promedio
FROM products p
JOIN categories c ON c.id = COALESCE(p.parent_id, p.category_id)
WHERE p.country = 'MLC'
  AND p.snapshot_date = (SELECT MAX(snapshot_date) FROM products WHERE country = 'MLC')
GROUP BY c.name
ORDER BY pct_en_oferta DESC;
```

### Excluir snapshots tomados en feriado

```sql
-- baseline "limpia" sin distorsión de feriado nacional
SELECT *
FROM products
WHERE country = 'MLC' AND holiday_name IS NULL;
```

---

## Tabla `sync_progress`

Checkpoint **por categoría** de cada corrida del sync. Permite (a) saber en qué punto se cayó un sync, (b) retomar lo que faltaba sin re-scrapear lo que ya se hizo. La pobla y mantiene `ProductCollectionService`.

| Columna | Tipo | Null | Qué representa | Valor para análisis |
|---|---|---|---|---|
| `id` | `int` PK | NO | Clave primaria interna autoincremental. | Infraestructural. |
| `sync_run_id` | `varchar(100)` | NO | ID estable de la corrida. Formato: `{siteId}-{ISO-timestamp con `:` y `.` reemplazados}` (ej. `"MLC-2026-05-23T03-00-00-000Z"`). | Operacional: permite agrupar logs y métricas de una corrida específica, y es lo que `POST /sync/resume/:siteId` usa para retomar. |
| `country` | `varchar(10)` | NO | Site al que pertenece la categoría que se está procesando. | Permite consultas operacionales "qué quedó pendiente en este país" sin escanear toda la tabla. |
| `category_ml_id` | `varchar(50)` | NO | ML ID de la categoría raíz que se está scrapeando (ej. `"MLC1512"`). | Operacional: identifica qué categoría falló o quedó pendiente para reintentar puntualmente. |
| `status` | `varchar(20)` | NO | Estado del checkpoint: `"pending"` \| `"in_progress"` \| `"done"` \| `"failed"`. | Operacional: alimenta dashboards de monitoring de runs y al endpoint `/sync/resume`. |
| `error_msg` | `text` | SÍ | Mensaje de error truncado a 1000 chars cuando `status = "failed"` (ej. `"Tripped after 10 consecutive failures..."`). | Operacional: post-mortem de runs caídos sin tener que abrir los logs de GitHub Actions. |
| `started_at` | `timestamp` | SÍ | Cuándo arrancó esta categoría (NULL hasta que pasa a `in_progress`). | Operacional: cálculo de duración por categoría → input para mejorar concurrencia y detectar regresiones de performance. |
| `completed_at` | `timestamp` | SÍ | Cuándo terminó (done o failed). | Operacional: pareada con `started_at` da la duración real por categoría. |
| `created_at` | `timestamp` | NO (default `now()`) | Cuándo se creó el row (al abrir el sync_run). | Operacional: identifica cuándo se planificó la categoría, vs cuándo realmente arrancó. |

**Constraints e índices:**
- `UNIQUE(sync_run_id, category_ml_id)` — un sync_run no puede tener dos filas para la misma categoría.
- `INDEX(country, status)` — para queries "qué quedó pendiente en este país".
- `INDEX(sync_run_id)` — para queries "todo el progreso de esta corrida".

**Ciclo de vida:**
1. `openSyncRun()` inserta una fila por categoría con `status = "pending"`.
2. Al empezar cada categoría → `status = "in_progress"`, `started_at = now()`.
3. Si termina bien → `status = "done"`, `completed_at = now()`.
4. Si falla (excepción NO relacionada al circuit breaker) → `status = "failed"`, `error_msg`, `completed_at`. El sync continúa con las demás categorías.
5. Si el **circuit breaker** dispara → la categoría in-flight se marca `failed`, las que aún estaban `pending` quedan así, y `collect()` retorna con `aborted` poblado. Las nuevas no arrancan.

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
