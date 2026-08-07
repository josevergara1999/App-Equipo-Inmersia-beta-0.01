# CLAUDE.md

Guía para Claude Code (claude.ai/code) al trabajar en este repositorio.

## Comandos

```bash
npm start      # servidor
npm run dev    # servidor con reinicio automático
```

Escucha en `PORT` (10000 por defecto). **No hay build**: el frontend se sirve tal cual desde
`public/`.

## Antes de tocar `public/index.html`, lee esto

Babel transpila **en el navegador**. Un error de sintaxis JSX no da aviso al guardar: da una
**página en blanco**. Valida siempre antes de recargar:

```js
// node, desde la raíz del repo
const Babel = require("./public/index_files/babel.min.js.descarga");
const html = require("fs").readFileSync("public/index.html", "utf8");
const code = html.match(/<script[^>]*type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];
Babel.transform(code, { presets: ["react"] }); // lanza con el número de línea
```

El archivo pasa de las 4.900 líneas y **todo vive ahí**: componentes, hooks y utilidades. Para
reescribir una sección grande conviene escribir el componente completo aparte y empalmarlo con
un script de Node (buscando `function XPg(` y el `function` siguiente) en vez de encadenar
muchas ediciones pequeñas.

## Arquitectura

**SPA de React en un solo archivo + backend Express.** Sin bundler. React 18, ReactDOM y Babel
Standalone vienen de CDN.

- Todo el estado vive en el componente raíz `Main` (`useState`/`useMemo`/`useRef`).
- Los datos se cargan al montar con `DB.loadAll()` y se guardan con `dbSave(key, value)`
  (debounce de 800 ms).
- Hay guardas para no pisar Supabase con arrays vacíos (`initTrack*` y `hadData`).
- El objeto `API` enruta **todas** las llamadas externas por el servidor. Nunca llames a una
  API externa desde el frontend.

Alias de componentes: `Ic` (icono), `Av` (avatar), `Bt` (botón), `Bg` (píldora), `Md` (modal),
`Fd` (campo de formulario).

### Diseño visual

Paleta en las constantes `PC` / `D` (fondo `#05060B`, cian `#6FE7F2`, peri `#9BB4FF`, lavanda
`#C9BFFF`, rojo `#FF8B8B`). Helpers: `D_CARD`, `D_MARCO`, `dPill`, `dGrupo`, `dNav`. El tema es
único; el conmutador de variantes se quitó y `body[data-variant]` queda fijo en `A`.

Las secciones nuevas salen de exports de Claude Design (`~/Downloads/*.dc.html`). **Ese
archivo tiene dos partes y hay que leer las dos**: el markup con `<sc-if>`/`<sc-for>`, y más
abajo el método `…Vals()` con los tintes, los mapas de color y las reglas de transición. Leer
solo el markup produce trabajo que hay que rehacer.

### Backend (`server.js`)

- Gemini 2.5 Flash (`/api/ai/generate`, `/api/generate-acta`, `/api/meta/advisor`)
- Correo con Resend (`/api/notify`)
- OAuth de Google, login **y** calendario en el mismo paso (`/api/auth/google*`)
- Calendario y reuniones con Meet (`/api/gcal/*`)
- Subida a Supabase Storage (`/api/upload`, `/api/upload/status`)
- Centro de notificaciones y web push (`/api/notifs*`, `/api/push/*`)
- Meta Ads / Instagram y Atlas (`/api/meta/*`, `/api/atlas/*`)
- Publicación en redes con Zernio (`/api/social/*`)

Casi todas las rutas van tras `requireAuth`, que valida un HMAC en la cookie HttpOnly
`_iauth`. La emiten tanto el callback de Google como `/api/auth/login`. Atlas usa la cabecera
`x-atlas-key` aparte.

`TEAM` en `server.js` es un **espejo de `INIT_USERS`** (mismos ids): el servidor necesita
traducir ids a correos por su cuenta, sin nadie con la app abierta. Si entra o sale alguien del
equipo, hay que tocar los dos lados.

### Base de datos (Supabase)

Tabla única `app_data` con `key` / `value` / `updated_at`, usada como almacén clave-valor.
Claves: `companies`, `tasks`, `extras`, `planners`, `planner_drafts`, `teamPay`, `billRcpts`,
`gcal_tokens`, `prospects`, `guiones`, `grabs`, `reuniones`, `eventos`, `notifs`, `push_subs`,
`notif_daily`, `user_creds`, `social`. Los binarios van al **Storage** (bucket `contenido`),
nunca a esta tabla.

### Variables de entorno

Ver `.env.example`, que está al día. Las que suelen faltar: `SUPABASE_SERVICE_KEY` (sin ella no
se pueden subir reels: el tope queda en 3 MB), las tres de `VAPID_*` (sin ellas no hay push) y
`ZERNIO_API_KEY` (sin ella no se publica en Instagram, pero la app lo dice y no rompe).

## Modelo de dominio

**Empresas** tienen un plan que define **cuántas piezas de cada tipo entran en el mes**.

### Los cupos son un número, no una cosa

`genTasks` ya no existe. Materializaba cada unidad del plan como una tarea vacía —"Post 1
Fauna", "Historia 3 Fauna"— y esas tareas fantasma ocupaban sitio en la fila `tasks`, salían en
las listas sin que nadie las pidiera y, si alguien las movía de estado, se quedaban ancladas
para siempre sin forma de sacarlas. Eran 72 de 139 tareas. Ahora:

```
disponible = incluido − aprobadas − en curso
```

**El cupo se confirma como gastado cuando el cliente aprueba**, no antes: publicar viene después
y ya depende de él. Pero lo que está en camino —en producción, listo, esperando respuesta o
corrigiéndose tras un rechazo— resta igual, porque no se puede prometer dos veces el mismo
post; ese descuento es provisional y se ve aparte (`aprobadas` vs `enCurso`).

- `incluidoDe(co)`: lo que contrata el cliente, por tipo. `co.incluido` pisa a la plantilla de
  `PLANS`, porque los planes se negocian caso a caso y tienen que editarse sin tocar el código.
  Se ajusta con los ± de la tarjeta de la empresa.
- `usadasEnMes()`: cuenta las piezas reales. Se imputan al mes de su fecha; **las que no tienen
  fecha cuentan solo en el mes en curso** — si contaran en cualquier mes que se mirara, una
  pieza sin agendar aparecería consumida en todos a la vez.
- `co.ajuste[mes]`: lo que ya venía consumido de fuera de la app, que es como se lleva el
  registro real. Se mete a mano al empezar el mes y de ahí en adelante baja solo.
- `<Cupos>` muestra el saldo en Contenido y Org Semanal, con el tipo agotado en rojo.

**El cupo avisa, no bloquea.** Producir de más se factura como adicional (`extraSlot`), y esa
es una decisión del equipo, no de la app.

**Tipos** (`TT`): `post`, `historia`, `reel`, `video_pro`, `visita`, `custom`, `repost`.

**Roles**: `admin`, `editor`, `visualizador`, `Sales` (solo Prospectos), `cliente` (solo su
portal). Aparte del rol, `vota: true` marca a quienes deciden si una pieza sale al cliente
(Cleme, Gali, Javi, Jose) — se lee con el helper `votantes()`.

## Flujo de contenido

El equipo produce, **el cliente decide cuándo se publica**. Una sola tarea lleva todo el ciclo:
`state` y `date` son independientes, y eso es lo que permite representar "aprobada pero sin
agendar".

La página **Contenido** muestra cinco etapas apiladas, no un tablero de columnas:

1. **En producción** — sin material todavía.
2. **Listo** — tiene archivo. Aquí se abre la votación: **solo cuando los cuatro votantes
   aprobaron** aparece el botón para enviar al portal.
3. **Enviado al portal** — en la bandeja del cliente.
4. **Rechazado por cliente** — vuelve con el motivo; se sube la corrección y la versión
   anterior se guarda en `revisions` para que el cliente vea el antes y el después.
5. **Aprobado por cliente** — cerrada.

Aquí solo hay piezas reales: el plan ya no genera huecos (ver *Los cupos son un número*). Se
crean con "+ Nueva pieza", desde Org Semanal, o soltando varios archivos a la vez —cada archivo
crea su pieza mientras quede cupo del mes; lo que sobra se crea como adicional con un clic
aparte, porque se factura distinto. La papelera de cada tarjeta borra la pieza y, si venía de
Org Semanal, también su item; si es un cupo vacío del sistema viejo, lo libera en vez de
destruirlo.

### Sincronización con Org Semanal — leer antes de tocar

Contenido trabaja sobre `tasks`; Org Semanal sobre `planners[].items`. Los une **`itemId`**.

**Se confirma pieza por pieza, desde su propia tarjeta.** El botón "Guardar y sincronizar" de
toda la semana ya no existe: hacía dos cosas a la vez (grabar el planner y volcarlo al
calendario), así que había que acordarse de pulsarlo para no perder lo escrito y de paso subían
al calendario piezas a medio llenar. Ahora:

- El planner **se guarda solo** (efecto de `planners` en `Main`, con las mismas guardas que
  `tasks`). Confirmar es decidir que la pieza sale, no la forma de no perder el trabajo.
- `confirmarItem()` vuelca **una** pieza a `tasks` y avisa a su producción más los admins.
- `confirmadaSig` es la firma de los campos que se vuelcan. Si cambia alguno, la pieza vuelve a
  quedar por confirmar. Los items sin firma pero con tarea son de antes de este cambio y se dan
  por confirmados.

Las tareas se reconocen por `itemId` y se conservan; **antes se borraban y recreaban de cero**, y
en cada guardado se perdían archivos, votos, comentarios y la respuesta del cliente, además de
cambiar los ids y romper los guiones vinculados.

**`salioAlPortal(t)` decide quién manda.** Desde que el cliente ve una pieza, mandan su estado,
su fecha y su material por sobre el planner. La regla mira tres cosas —estado, `clientApproval`
y `revisions`— y las tres hacen falta: una pieza rechazada vuelve a `en_proceso`, y al subir la
corrección `clientApproval` se pone a `null`. Mirando solo el estado, en esos dos momentos
parecía una pieza cualquiera en producción, así que confirmarla desde Org Semanal devolvía los
archivos del planner —la versión que el cliente había rechazado— y borraba la corrección. Una
pieza rechazada **no se elimina: se arregla hasta que se apruebe**, y nada puede deshacer eso.

Borrar un item **borra también su tarea** (`borrarTareasDe`). Antes solo desaparecía del planner
y la tarea quedaba huérfana en Contenido para siempre; lo tapaba de rebote el guardado global,
que recreaba la semana entera. Contenido detecta las que quedaron sueltas (`huerfanas`) y ofrece
limpiarlas, pero solo con `planners` cargado: con la lista vacía, todo parecería huérfano.

Al crear una pieza desde Contenido se escribe en los dos lados a la vez (item + tarea con el
mismo `itemId`).

## Notificaciones

El push es el aviso del momento; `app_data.notifs` es el historial, que **se guarda siempre**
aunque el push falle. Lectura por persona. Toda escritura pasa por una cola: dos avisos
simultáneos sobre una fila única se pisaban entre sí. `dedupKey` evita repetir el mismo aviso
dentro de 12 h.

Disparadores en la app: asignación de tarea, paso a producción, listo para votar, alguien pide
cambios, aprobación unánime del equipo, envío al cliente, respuesta del cliente, reunión,
evento, confirmación de una pieza en Org Semanal, y pago a un integrante (privado, solo a quien
lo recibe). **Al que ejecuta la acción nunca le llega su propio aviso.**

### Suscripciones en iOS — por qué se "perdían"

**`pushsubscriptionchange` no dispara de forma fiable en iOS.** Es un hueco documentado de
WebKit, sin respuesta de Apple. Por eso el handler del service worker es un extra, y lo que de
verdad sostiene la suscripción es que **la app la vuelve a registrar cada vez que abre** (upsert
por endpoint, en `PushBtn`). Si se quita eso, el push se cae solo y la única salida es que cada
persona pulse el botón de nuevo.

Cuando el endpoint sí rota, quien se re-suscribe es el service worker, que **no conoce a la
persona**: solo sabe cuál era el endpoint anterior. Manda `renewedFrom` y el servidor hereda de
ahí el correo. Sin eso la suscripción entra anónima, deja de calzar con `onlyEmails` y la persona
sigue suscrita sin recibir nada.

El estado dormido del servidor **no puede** invalidar una suscripción: el push va del servidor a
Apple y de Apple al teléfono; la suscripción vive en el navegador. No mezclar los dos problemas.
Y no montar un keep-alive contra Render: el plan gratuito da 750 h/mes por workspace y
mantenerlo despierto las agota, con lo que el servicio queda **suspendido** el resto del mes.

Por horario, en el servidor: resumen personal al empezar el día (ventana 08:00–20:00 hora de
Chile, una vez al día), IVA el 20, días de grabación, y recordatorios de reunión y evento la
mañana del día y una hora antes (repaso cada 10 min, ventana de 45–75 min).

Reuniones y eventos avisan **siempre también a los admins**, en una sola lista deduplicada por
id para que el admin que además está apuntado reciba un aviso y no dos.

## Reuniones con Google Meet

Al agendar se crea el evento con enlace de Meet y Google manda la invitación a cada invitado
(`conferenceDataVersion=1` genera el enlace, `sendUpdates=all` despacha los correos).

**El organizador es siempre la cuenta de INMERSIA**, fijado en el servidor y no aceptado por
parámetro: si se pudiera elegir desde el navegador, cualquiera con sesión podría crear eventos
en el calendario personal de otro del equipo.

El permiso de calendario se pide en el mismo inicio de sesión con Google, con el scope acotado
a `calendar.events`. Si Google rechaza el refresh con `invalid_grant`, el token se borra y la
app pide reconectar en vez de fallar en silencio.

## Publicar en Instagram (Zernio)

El botón 📸 sale **solo en la columna "Aprobado por cliente"** de Contenido, y desaparece una vez
publicada: el cupo se gasta al aprobar y publicar viene después, y una publicación no se deshace.

**Un profile de Zernio por empresa.** Es el contenedor de cuentas de una marca, así que sumar un
cliente no toca a los demás y darlo de baja es borrar el suyo. El mapa
empresa → profile → cuenta vive en `app_data.social`, y lo escribe `/api/social/accounts`.

- **Zernio manda sobre el mapa local.** Esa ruta lo reescribe entero en vez de ir agregando: si
  el cliente desconecta su cuenta desde Zernio, aquí tiene que desaparecer.
- **`profileId` viene poblado como objeto** (`{_id, name}`), no como string. Un `String()` a
  secas daba `"[object Object]"`, el mapa salía vacío y publicar respondía `no_conectada`
  teniendo la cuenta conectada.
- **`/publish` rechaza antes de llamar a Zernio** si el archivo no tiene URL pública o viene de
  Drive/Dropbox: Instagram descarga el archivo él mismo y sin URL directa muere del otro lado
  con un error que no explica nada.
- **200 no significa publicado.** Instagram procesa después; `/api/social/post/:id` consulta el
  estado real.
- La cuenta de Instagram **tiene que ser Business o Creator**. Es requisito de Instagram, no de
  Zernio, y no hay forma de saltárselo.

Las escrituras pasan por la cola `enCola`, la misma de los avisos: es la misma fila única y el
mismo *lost update*.

## Dominios y despliegue

Render, con despliegue automático al hacer push a `main`. La app responde en **dos dominios a
la vez**: el de Render y `portal.inmersiaperformance.cl`. La URL de retorno de Google se deriva
del dominio por el que entró la persona, **validada contra una lista blanca** en `server.js`
(confiar en la cabecera Host permitiría desviar el código de autorización). Si agregas un
dominio, hay que sumarlo ahí y en Google Cloud.

La web pública (`inmersiaperformance.cl`) es otro repo: `~/GitHub/inmersia-web`, HTML estático
en GitHub Pages. Tiene el botón "Portal" en la barra superior.

### El ping de las 8 a la 1 — no es tráfico raro

Render duerme el plan gratuito tras **15 minutos** sin tráfico y tarda **~1 minuto** en volver.
Dormido no es solo lento: **el proceso se detiene**, así que los `setInterval` de `repasoDiario`
y `repasoCorto` no corren y **los recordatorios por horario no salen**. El aviso de "reunión en
una hora" no se manda si nadie abrió la app en los 15 minutos previos.

Por eso hay un cron externo (cron-job.org) que pega a `/api/health` cada 10 min, **de 08:00 a
00:50 hora de Chile**. Ese endpoint es el correcto para esto: es público, solo devuelve
booleanos de configuración y no toca Supabase.

La ventana no es capricho, es presupuesto: el tier gratuito da **750 h/mes por workspace** y al
agotarlas Render **suspende** el servicio hasta el mes siguiente.

```
24/7            744 h/mes (mes de 31 días)  → 6 h de margen: demasiado al filo
08:00 – 01:00   527 h/mes                   → 223 h de margen
```

De madrugada duerme, que no le molesta a nadie. Si algún día se agrega otro servicio al mismo
workspace, **rehacer esta cuenta**: las horas se comparten. La salida soportada, si esto deja de
alcanzar, es cambiar el *instance type* del servicio a uno de pago — ojo, subir el plan del
workspace **no** quita las limitaciones de las instancias Free, hay que cambiar el tipo del
servicio.

## Trampas conocidas (todas costaron un rato)

- **`position: fixed` dentro del árbol de la app se rompe.** Cualquier ancestro con
  `transform`, `filter` o `will-change` lo vuelve relativo a ese ancestro. Todo lo que ocupa la
  pantalla entera se monta en el `<body>` con el helper `Portal`: los modales (`Md`), la barra
  inferior del celular y los overlays de página.
- **Cuidado con `animation-fill-mode: forwards` (o `both`) en animaciones que tocan
  `transform`.** El efecto queda aplicado para siempre y en iOS eso convierte al elemento en
  ancestro de referencia de los `fixed` que cuelguen de él. `.d-in` usaba `both` y el modal de
  Contenido se centraba a media altura del documento: se veía el fondo borroso y ningún diálogo.
  Usar `backwards`, que evita el parpadeo inicial sin retener nada al terminar.
- **Zona segura del iPhone.** El viewport declara `viewport-fit=cover`, así que la app se
  dibuja bajo la barra de estado. Todo lo anclado arriba o abajo necesita
  `env(safe-area-inset-top/bottom)`.
- **Desplegables anclados a la derecha** se salen de la pantalla en el teléfono cuando su botón
  está a la izquierda de la tarjeta. Anclarlos a la izquierda y limitar el ancho.
- **El service worker no debe tocar el video.** Interceptar peticiones con `Range` deja el
  reproductor en negro, y una respuesta 206 no se puede guardar en Cache Storage.
- **Nunca guardar video en base64 en una tarea.** Todas las tareas viven en una fila que
  `DB.loadAll()` trae entera en cada carga, para todos los usuarios.
- **`DB.loadAll()` trae las tareas de todas las empresas** y filtra en el cliente: el navegador
  de un cliente recibe contenido de otros. Arreglarlo requiere filtrado por fila, no un cambio
  de UI.
- **Los iconos se generan midiendo, no a ojo.** El recorte escrito a mano cortaba el arco
  inferior del logo.

## Estado y pendientes

Rediseño aplicado a Dashboard, Org Semanal, Guionado y Contenido. **Faltan Pagos y el portal
del cliente** (export en `~/Downloads/Inmersia Portal Cliente.dc.html`).

Sin probar con uso real: las invitaciones de Meet.

**Storage funciona en producción** (comprobado en agosto de 2026 con una subida real, no con
`/api/upload/status`). El bucket `contenido` existe, es público, sin tope propio ni lista de
MIME; el límite real son los **100 MB** de `uploadBig`. Los 3 MB que menciona la app son solo
del respaldo en base64, que ya no se usa mientras Storage responda.

**Cuidado al dar Storage por bueno.** `estadoStorage()` solo *lee* los metadatos del bucket, así
que `ready: true` no prueba que la llave pueda escribir — es justo el caso que dejaba "listo" y
moría en cada subida. Para comprobarlo de verdad hay que subir un archivo. `explicarStorage()`
sigue traduciendo el fallo a la causa concreta (bucket inexistente, MIME no permitido, tope de
tamaño, llave sin permiso de escritura).

**Nunca subir al repo**: `.env`, `public/__mocktest*.html`, `public/__demo_media/` (videos
reales de clientes) ni ningún `client_secret_*.json`.
