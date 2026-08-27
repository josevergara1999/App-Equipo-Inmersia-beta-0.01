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
- **El navegador NO habla con Supabase directamente.** `DB` pega a `/api/data` del servidor
  (GET todo, GET una clave, POST guardar), con sesión (`requireAuth`) y la `service_role` que
  vive solo en el servidor. Antes la clave publishable estaba en el HTML y la tabla `app_data`
  tenía una policy `"Allow all access"` para el rol `public`: cualquiera leía los tokens de los
  clientes y podía borrar la base. Ahora la policy está quitada (RLS deniega al anónimo) y el
  único camino es el servidor. Los tokens (`gcal_tokens`, `meta_token`, `user_creds`, `ig`,
  `push_subs`, `social`) están en `CLAVES_PRIVADAS` y **nunca salen del proxy** (403).
- **`DB.loadAllStrict()` LANZA si la lectura falla** (en vez de devolver `{}`). Lo usan los
  sitios que releen-antes-de-escribir (safeSaveTask, confirmarItem, limpiar/quitar semana): con
  el tolerante, un fallo daba `{}`, `fresh.tasks||[]` daba `[]` y se escribía un array vacío
  ENCIMA de las tareas de todas las empresas. `DB.save` devuelve si de verdad guardó.
- **Las listas con id se guardan POR DIFERENCIA, nunca volcando el array entero.** El `dbSave` de
  `tasks`, `companies`, `galerias` y `planners` pasa por `encolarGuardado` → `guardarDiff`: se
  compara la copia local contra el **baseline** (la última versión que sabemos que está en el
  servidor) y solo viajan las filas que esta pestaña cambió, aplicadas sobre una relectura fresca.
  Hay **cola por clave**, así que dos guardados de la misma lista no vuelan a la vez.
  - Antes se hacía POST del array completo desde memoria, sin cola, sin releer y sin comparar.
    Dos POST concurrentes no tienen orden garantizado: ganaba **el que llegaba último aunque
    llevara datos más viejos**. El 21-ago-2026 eso revirtió un envío al portal ya guardado: el
    aviso "📤 Enviada al cliente" salió, la pieza se quedó en `en_proceso` con el rechazo anterior
    pegado, al cliente no le apareció nada, y la pantalla del equipo seguía diciendo "Enviado al
    portal" porque su memoria sí tenía el cambio. Se diagnosticó cruzando las horas de `notifs`
    con el contenido de `app_data.tasks`: la copia que ganó traía los votos de las 21:14 pero no
    el envío de las 21:28, así que era una copia capturada entre medias que llegó después.
  - **El baseline se fotografía al capturar el valor, no al ejecutar la escritura.** Calculando el
    diff contra el baseline del momento de escribir, una copia rezagada aparece llena de cambios
    —los de otro, del revés— y los escribe como suyos. Con la foto correcta, esa copia no tiene
    nada que escribir y la escritura se cancela entera.
  - **Sin baseline no se escribe.** Si la lectura de arranque falló no sabemos qué cambió esta
    pestaña, y volcar el array "por si acaso" es el fallo de arriba. Se aborta y se avisa: perder
    un cambio propio se nota, pisar el de otro no.
  - **Un guardado que no llega se ve.** `registrarAvisoGuardado` conecta `dbSave` —que vive fuera
    de React— con `addN`. El portal del cliente ya comprobaba la escritura antes de cantar éxito
    (`safeSaveTask`); esto es el mismo trato para el lado del equipo.
  - `galerias` mantiene además su `guardarGalerias`, que relee y conserva `fav`/`favAt` del
    servidor: el cliente escribe ese campo por una ruta aparte y el diff no lo ve.
- **`uid()` para ids nuevos**, nunca `Date.now()+Math.random()*N|0` (ese OR truncaba a 32 bits →
  ids negativos y con choques; el id casa tareas e items en todo el flujo).
- El objeto `API` enruta **todas** las llamadas externas por el servidor. Nunca llames a una
  API externa desde el frontend.

Alias de componentes: `Ic` (icono), `Av` (avatar), `Bt` (botón), `Bg` (píldora), `Md` (modal),
`Fd` (campo de formulario).

### Diseño visual

Paleta en las constantes `PC` / `D` (fondo `#05060B`, cian `#6FE7F2`, peri `#9BB4FF`, lavanda
`#C9BFFF`, rojo `#FF8B8B`). **Las dos paletas tienen que tener las MISMAS claves**: `PC` arma sus
getters recorriendo las de `PALETAS.oscuro`, así que una clave que solo esté en `claro` no tiene
getter y devuelve `undefined` en los dos temas — sin error, con el estilo simplemente ignorado.
Pasó con `ambar`, `verde` y `rosa`: 56 lecturas sin color hasta el 25-ago-2026.

**Los colores de marca pasan por `tono()`.** Las empresas, los integrantes y los planes traen
colores de una paleta anterior hecha para brillar sobre negro (`#4ecdc4`, `#ff9ff3`…), y sobre el
papel del modo claro no se despegan del fondo: entre 1,0 y 3,1 de contraste. Como esos valores
viven en la base (`companies[].color`) no se pueden cambiar en el código, así que se traducen al
pintarlos. `TONOS_CLARO` tiene el hermano escrito a mano de los catorce conocidos —elegidos
dentro de la paleta clara, igual que `TT_COLORES.claro`— y cualquier otro cae en un cálculo que
conserva el tono, le recorta la saturación y le baja la luz hasta pasar de 3,4 de contraste. El
corte para decidir si hay que traducir es el **contraste real contra el fondo**, no la luminosidad
HSL: un neón saturado da 0,5 justo de luminosidad y se colaba entero. En modo oscuro no hace nada. Helpers: `D_CARD`, `D_MARCO`, `dPill`, `dGrupo`, `dNav`. El tema es
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
- Instagram directo con Meta, comentario → DM (`/api/ig/*`)

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
`notif_daily`, `user_creds`, `social`, `ig`, `galerias`, `briefs`. Los binarios van al **Storage** (bucket
`contenido`), nunca a esta tabla.

**RLS activo desde 10-ago-2026.** La tabla tiene Row Level Security y NO tiene policies para el
rol anónimo, así que la clave publishable no puede leer ni escribir. Todo acceso pasa por el
servidor con la `service_role` (que bypassa RLS). Por eso el servidor lee/escribe `app_data`
prefiriendo `SUPABASE_SERVICE_KEY` (ver `SB()` y los helpers inline). Si algún día se reactiva
el acceso directo desde el cliente, hay que volver a crear una policy — pero eso REABRE el
agujero. El frontend usa `/api/data/*` (GET todo/una clave, POST guardar), nunca la REST de
Supabase directo.

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
- `usadasEnMes()`: cuenta las piezas reales, imputadas a un mes. La regla exacta:
  - Una pieza en `no_realizado` **sin material** NO cuenta (es un cupo reseteado/liberado; la
    papelera de una pieza promete "el cupo queda libre").
  - Una pieza **aprobada/publicada** se ancla a su **mes de producción (`plannedDay`)**, no a la
    fecha de publicación: el cupo se gasta al aprobar y no se mueve aunque el cliente publique
    otro mes (si no, agendar cruzando mes movería un cupo ya gastado).
  - El resto va por su `date`; y **sin fecha, al mes en curso** (trabajo pendiente de agendar).
- `co.ajuste[mes]`: lo que ya venía consumido de fuera de la app, que es como se lleva el
  registro real. Se mete a mano al empezar el mes y de ahí en adelante baja solo.
- `<Cupos>` muestra el saldo en Contenido y Org Semanal, con el tipo agotado en rojo. En las
  dos va **plegado** (`compact`), como un botón "Cupo <mes> ▾" al lado de las acciones que
  gastan cupo: es un dato que se consulta justo antes de crear una pieza, no un titular que se
  coma el ancho entero cada vez que se abre la pantalla. Desplegado se ve igual que la franja.
  El panel sale por `useMenuFlotante` — ver *Trampas conocidas*.

**El cupo avisa, no bloquea.** Producir de más se factura como adicional (`extraSlot`), y esa
es una decisión del equipo, no de la app.

**Tipos** (`TT`): `post`, `historia`, `reel`, `video_pro`, `visita`, `custom`, `repost`.

**Roles**: `admin`, `editor`, `visualizador`, `Sales` (solo Prospectos), `cliente` (solo su
portal).

**El acceso al portal se genera desde la ficha de la empresa**, con un botón, y queda escrito en
la propia empresa (`co.portalEmail`) — que sí se guarda. Antes se creaba solo al dar de alta la
empresa y el aviso cantaba las credenciales, pero ese usuario se agregaba a `us`, que es
`useState(INIT_USERS)` y **no se persiste en ninguna parte**: al recargar volvía a las cuatro de
fábrica y el cliente no podía entrar nunca. El correo es el nombre de la empresa normalizado y la
clave es la de fábrica (`DEFAULT_PASS`, 1234) mientras no guarde otra.

El login **ya no exige que el cliente esté en `INIT_USERS`**: un correo desconocido se manda igual
al servidor. No abre nada — la cookie la emitía el servidor de todos modos, y el muro real está en
`scopeCliente`, que solo entrega la empresa que calce con el correo—, pero es lo que permite que
una empresa creada desde la app pueda entrar a su portal.

**Quitar el acceso es `co.portalOff`, y lo comprueba el LOGIN.** Borrar `portalEmail` no revoca
nada: el servidor acepta cualquier usuario con la clave de fábrica y resuelve la empresa por su
nombre, así que limpiar el campo deja la puerta igual de abierta. `/api/auth/login` mira
`portalOff` antes de emitir la cookie. Volver a generar el acceso pone `portalOff:false` — si no,
escribiría el correo y el login lo seguiría rechazando.

**El cliente pone su correo de contacto desde su portal** (`POST /api/perfil/correo`), y es el
mismo `co.email` que el equipo ya usaba para avisarle. Ruta propia y estrecha, como la de las
fotos favoritas: darle la clave `companies` le dejaría reescribir su plan, sus cupos y sus Drive.
Ese correo entra solo en las invitaciones de Meet al elegir la empresa.

**`_slug` (server.js) y el generador de accesos (frontend) tienen que dar EXACTAMENTE lo mismo.**
Es lo que empareja el correo del portal con el nombre de la empresa. Si no coinciden, el cliente
entra y ve una pantalla vacía, porque `scopeCliente` falla cerrado sin decir por qué. Aparte del rol, `vota: true` marca a quienes deciden si una pieza sale al cliente
(Cleme, Gali, Javi, Jose) — se lee con el helper `votantes()`.

## Flujo de contenido

El equipo produce, **el cliente decide cuándo se publica**. Una sola tarea lleva todo el ciclo:
`state` y `date` son independientes, y eso es lo que permite representar "aprobada pero sin
agendar".

**Invariante `aprobado ⇒ sin fecha`.** Al aprobar (portal del cliente, atajo del equipo
`cliAprueba`, checkbox del Dashboard `toggleHecha`, o el selector de estado del detalle), se
limpia `date` y el día que había planificado el equipo se guarda en **`plannedDay`**. El banco
«Listo para agendar» del cliente es literalmente `!t.date`, así que la pieza aprobada cae ahí y
el cliente elige el día. `plannedDay` es además el ancla de facturación (ver `usadasEnMes`) y se
muestra como recomendación. TODOS los caminos que ponen `aprobado` deben respetar esto. El día
en **Org Semanal** es otra cosa (`item.day`, solo lo mueve el equipo arrastrando); limpiar
`date` no mueve el item del planner.

La página **Contenido** muestra cinco etapas apiladas, no un tablero de columnas:

1. **En producción** — sin material todavía.
2. **Listo** — tiene archivo. Aquí se abre la votación: **solo cuando los cuatro votantes
   aprobaron** aparece el botón para enviar al portal.
3. **Enviado al portal** — en la bandeja del cliente. **Es la única puerta de un solo sentido
   del flujo**, así que las dos que llevan a ella —el botón de Contenido y el de la tarjeta de
   Org Semanal— preguntan antes con el mismo aviso: una vez enviada no se le hacen cambios,
   solo se elimina, y corregir es cosa del rechazo del cliente. Desde aquí la tarjeta del equipo
   es de solo lectura: se queda con tipo, título, vista previa, cuántas versiones van y los
   atajos del portal; se van el encargado, el nombre del archivo, "+ Otra versión" y la casilla
   de material adjunto, porque todos cambiarían lo que el cliente ya tiene delante.
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
- **Ya no hay botón de confirmar.** Lo hace el último paso del asistente de alta, y de ahí en
  adelante `aplicarYSync()` vuelve a volcar sola la pieza cada vez que cambia de estado o se le
  sube el archivo — con `silencioso:true`, que se calla el toast y el aviso de asignación pero
  deja pasar el de votación. Antes había que acordarse de pulsar «Confirmar» después de cada
  cambio, y mientras tanto Contenido mostraba una pieza que en el planner ya iba dos pasos más
  adelante. `aplicarYSync` recibe la lista de items **ya actualizada**: `items` es la copia del
  render y todavía no tiene el cambio, así que confirmar con la vieja escribiría el estado
  anterior y encima lo marcaría como confirmado.

### La tarjeta de Org Semanal muestra solo el paso en el que va

La tarjeta abierta tenía diez controles a la vez —tipo, título, estado, producción, drive,
automatización, descripción, referencias, archivo y confirmar— y quien no conoce la app no sabía
por dónde empezar, qué era obligatorio ni qué podía dejar para después. A la hora de votar, el
voto quedaba enterrado entre campos que ya no venían al caso. Ahora la tarjeta enseña lo que hace
falta en ese punto y nada más:

- **Alta por pasos** (`AsistentePieza`): 1) tipo y título · 2) encargado (+ nota opcional) ·
  3) detalles opcionales: carpeta de Drive **solo si la empresa tiene**, automatización **solo en
  reel y post**, y referencias. El último botón es el que crea la pieza en Contenido.
- **La marca de «está en el asistente» es explícita** (`editandoItem`), no se deduce de que falten
  datos: dedujéndola, el asistente se cerraba solo al elegir encargado —a mitad del paso 2— y la
  pieza saltaba a la ficha sin pasar por el último paso.
- **Ficha** (borrador / en producción / del portal en adelante): tipo, título en grande, encargados
  y el enlace directo al Drive, **todo de solo lectura**. Los datos del alta se cambian volviendo a
  entrar al asistente con «Editar»; sueltos en la tarjeta eran la mitad del ruido y se tocaban sin
  querer sobre piezas ya en marcha.
- **Listo** convierte la tarjeta en la pantalla de subir el archivo y, con el archivo puesto, en
  preview grande + los botones de votar. Por eso **«Listo» ya no exige tener el archivo**:
  exigirlo antes dejaba al encargado sin ningún sitio donde subirlo. Enviar al portal sí lo sigue
  exigiendo, junto con los cuatro votos.
- **El voto es uno solo.** El planner lo guarda en `item.votes` y Contenido en `task.votes`, y
  `confirmarItem` los fusiona dando prioridad a la tarea: escribiendo solo en el item, el voto
  recién emitido no llegaba nunca a Contenido. `votosDe()` lee fusionado y `votar()` escribe en
  los dos lados.
- «+ Agregar contenido» abre la tarjeta ya preguntando; cancelar una pieza recién creada y vacía
  la descarta sin dejar rastro, en vez de sembrar el día de filas «Sin título…».

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

## Brief de cliente

Un brief por empresa en `app_data.briefs`, y **el cliente lo rellena por un enlace público**, sin
cuenta: `inmersiaperformance.cl/brief/<token>`. La razón es de calendario — el brief se manda el
día que se cierra el trato, y en ese momento la empresa todavía no tiene portal, porque dar de
alta un usuario de portal es tocar `INIT_USERS` y `CLIENTES` y desplegar.

Lo que sustituye a la sesión es el token: 32 hex del generador del navegador, creado la primera
vez que se abre o se copia el enlace de esa empresa. **La fila se busca POR el token** y de ahí
sale la empresa; el `companyId` no se acepta por parámetro, así que no hay forma de apuntar a
otra desde el navegador. Por eso `briefs` **no está en `CLAVES_CLIENTE`**: si se le entregara al
portal, un cliente vería el token de las demás.

- Las preguntas viven en **`public/brief-def.js`**, que cargan las tres puntas: el formulario
  público, la app del equipo y el servidor (`require`). Escritas dos veces, se cambia una pregunta
  en un lado y el otro sigue leyendo el rótulo viejo sobre la respuesta nueva.
- **La sección 07 no la ve el cliente.** Son notas del asesor sobre él; el servidor filtra por
  `CLAVES_CLIENTE` del brief y las descarta aunque lleguen a mano.
- El POST **funde** sobre lo guardado: volver al enlace a corregir dos campos no borra el resto.
- **Sin «plan seleccionado»**, que era la pregunta 06 del documento original: el plan vive en la
  ficha de la empresa y es lo que calcula el cupo. Preguntarlo aquí abre la puerta a dos verdades.
- El **repaso con IA** (`/api/brief/:companyId/analisis`) se guarda en la fila y se borra solo en
  cuanto el cliente cambia una respuesta: un análisis de un brief viejo afirma cosas que ya no son.
- El brief entra además como contexto del chat del portal (`/api/ai/post-chat`,
  `briefDeQuienPregunta`). Sin él la IA solo sabe leer números; con él responde en los términos
  del negocio de quien pregunta.

## Sesiones de fotos

Las fotos de una sesión se entregan **por la app**, no por Drive: el cliente las ve donde ya entra
a aprobar su contenido y deja de haber una carpeta más que compartir, ordenar y perder cuando
alguien cambia el permiso del enlace.

Se suben en **Contenido → Fotos**, la cuarta pestaña, y no en una página aparte: es material de la
misma empresa que el resto de Contenido, esa pantalla ya trae el selector de empresa y el estado
de Storage, y con una página propia había que elegir la empresa dos veces y mirar en dos sitios lo
que se le entregó al cliente. En el portal sí es una pestaña propia (**Fotos**), que solo aparece
cuando esa empresa ya tiene alguna sesión publicada.

Viven en `app_data.galerias`, aparte de `tasks`: una sesión no es una pieza del plan, no gasta
cupo, no se vota y no se publica en Instagram. Mezclarlas habría metido cientos de fotos en la
fila que `DB.loadAll()` trae entera en cada carga.

```
{ id, companyId, companyName, titulo, fecha, nota, visible, fotos:[{id,name,type,url,size,at}],
  createdBy, createdAt, publicadaAt }
```

- **En la fila va solo la URL.** El binario se sube por `/api/upload` al mismo bucket `contenido`
  que el material de las piezas. Nunca base64 aquí, por lo mismo que en `tasks`.
- **`visible` es una decisión, no un efecto de haber subido el archivo.** Una sesión a medio subir
  no puede aparecerle al cliente solo porque exista la fila. El corte lo hace el **servidor**
  (`scopeCliente`), no el navegador: al cliente se le entregan únicamente las galerías de SU
  empresa **y** con `visible !== false`. `galerias` está en `CLAVES_CLIENTE` solo para LEER — el
  cliente sigue sin poder escribir nada que no sea `tasks`.
- **Se sube foto por foto y cada una se guarda al llegar.** Si la número 40 falla, las 39 anteriores
  ya están puestas: reintentar es soltar las que faltan, no subir la sesión entera otra vez.
- **Quitar una foto quita la referencia, no el objeto de Storage** — igual que con el material de
  las piezas. La app no borra binarios, así un descuido no destruye el original.
- Al publicar se avisa al cliente por correo (`co.email`) y al equipo por la campanita. Ocultar no
  avisa a nadie.
- La rejilla es **3:4 vertical**: las fotos de sesión son retratos y una celda cuadrada corta
  cabezas y pies. El recorte lo hace el CSS sobre la foto completa, que es la que abre el visor —
  lo que se ve recortado nunca es lo que se descarga.
- El visor (`ZoomLayer`, el mismo de toda la app) lleva **Descargar**. El atributo `download` de un
  `<a>` lo ignora el navegador cuando el archivo vive en otro origen —y Storage lo es—, así que un
  enlace a secas solo NAVEGA a la foto. `descargarArchivo()` baja el binario y lo guarda desde un
  blob del mismo origen, que sí respeta el nombre.
- `galerias` **no** está en `CLAVES_LIMPIABLES`: son fotos reales de clientes, no contenido de
  prueba.

### La rejilla NUNCA carga los originales

La primera sesión real —33 fotos de Huemul— eran **562 MB**, con archivos de **15,8 MB cada uno**.
Al abrir la pestaña, el teléfono de los dueños se quedaba sin memoria y **recargaba la pestaña**:
la app volvía a su pestaña por defecto («Por aprobar») y al cliente le parecía que la aplicación
lo echaba. Se reportó como un fallo de sesión y era peso de imágenes. No es el peso de bajada lo
que mata, es el de **descompresión**: una JPG de 15 MB ocupa ~60 MB de píxeles en RAM, y con seis
en pantalla ya son ~360 MB.

- Cada foto lleva **`thumb`** (640 px de lado mayor, JPEG 0.78, ~70 KB) además de `url`. La
  rejilla pinta `fMini(f)` = `thumb || url`; el visor y la descarga siguen usando la original.
- **La miniatura la hace el navegador de quien sube** (`miniaturaDe`, canvas). No hay alternativa:
  Supabase tiene la generación de miniaturas **deshabilitada en este plan** —comprobado contra
  Storage: `FeatureNotEnabled`— y el servidor no lleva librería de imágenes.
- Las sesiones anteriores se arreglan con **«Generar miniaturas»** en la tarjeta de la sesión: baja
  cada original, la reduce aquí y sube la copia. Es de una vez por sesión y **desde un computador**
  (son cientos de MB de bajada). Mientras falten, la tarjeta lo avisa en rojo diciendo qué le pasa
  al cliente, no «optimiza tus imágenes».
- `FotoGrid` pinta **de a 12** con «Ver más». Es la red de seguridad para lo que todavía no tenga
  miniatura: aunque cada archivo pese 15 MB, el navegador nunca abre 33 a la vez.

### Favoritas — el único campo que escribe el cliente

El cliente marca con ♥ las fotos que quiere usar, y el equipo las ve marcadas en Contenido →
Fotos con su contador. Es el dato por el que el equipo vuelve a entrar después de entregar.

- **Ruta propia, `POST /api/galerias/favorito`**, no `POST /api/data/galerias`: darle esa clave al
  cliente le dejaría reescribir títulos, ocultar sesiones o borrar fotos. Aquí solo se acepta
  marcar/desmarcar **una** foto de **una** sesión, y el servidor comprueba por su cuenta —buscando
  la sesión por id— que sea de su empresa y esté publicada. Nada de eso viaja en el cuerpo, así
  que no hay nada que falsear desde el navegador. Comprobado: cliente de otra empresa → 403, sin
  sesión → 401, foto inventada → 404.
- Va por `enCola`, la cola de los avisos: `galerias` es una fila única y marcar favoritas se hace
  a ráfagas, que es el caso exacto del *lost update*.
- **El equipo escribe la fila ENTERA y el cliente solo `fav`.** Si alguien del equipo editaba una
  sesión mientras el cliente marcaba, su copia en memoria —que no tenía las marcas— las borraba
  sin que nadie se enterara. Por eso el guardado del equipo (`guardarGalerias` en `Main`) relee
  del servidor y **conserva `fav`/`favAt` de allá** antes de escribir; las fotos recién subidas,
  que aún no existen en el servidor, se quedan con lo suyo.
- En el portal el corazón se pinta al instante y se guarda después, con vuelta atrás y aviso si
  la escritura falla: en el teléfono se marcan varias seguidas y esperar al servidor en cada
  toque dejaba el corazón medio segundo por detrás del dedo.
- `FotoGrid` recibe `onFav` **solo desde el portal**. Sin ella el corazón se sigue viendo en las
  marcadas —y no se puede pulsar—: para el equipo esa marca es información, no un control.

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

## Comentario → DM (Meta directo, sin Zernio)

**Zernio no sirve para esto y está comprobado:** su `POST /inbox/comments/reply` devuelve un
`commentId`, o sea publica un comentario **público**. Y un DM a alguien que no te escribió
hace poco lo rechaza el propio Instagram con `outside of allowed window` — comentar **no** abre
esa ventana. Lo único que la abre es la *respuesta privada*, una capacidad de Meta que Zernio
no expone. De ahí que `/api/ig/*` hable con Meta directamente.

```
POST https://graph.instagram.com/v23.0/<IG_ID>/messages
{ "recipient": { "comment_id": "<ID>" }, "message": { "text": "…" } }
```

- **Un solo mensaje por comentario**, dentro de **7 días**. Para seguir, la persona responde.
  No es una limitación nuestra: es lo que evita que esto sea spam.
- **Standard Access basta para cuentas propias.** Para cuentas de clientes hace falta
  *Advanced Access*, que exige App Review y verificación de negocio.
- El webhook de Meta (campo `comments`) avisa **en tiempo real**, así que aquí no hay sondeo.
- **La firma del webhook se valida sobre el cuerpo crudo.** Por eso `express.json` guarda
  `req.rawBody`: validar sobre el JSON re-serializado no calza nunca.
- **Se contesta 200 antes de trabajar.** Meta corta a los 20 s y reintenta.
- `respondidos` en `app_data.ig` evita responder dos veces al mismo comentario: Meta reintenta
  la entrega, y el segundo intento sería un error porque solo se admite un mensaje. Se podan
  los de más de 7 días, que es la ventana en la que un comentario puede volver a dispararse.
- Los tokens duran 60 días y se renuevan solos cuando quedan menos de 10, **desde
  `repasoDiario`**. Antes la única llamada estaba en la pantalla de elegir publicación, así que
  la automatización se mantenía viva solo si alguien entraba ahí cada dos meses. Si aun así no
  se puede renovar, se avisa a los admins: el vencimiento silencioso es lo caro.

### Una cuenta de Instagram pertenece a UNA empresa

Puede quedar enganchada a dos —basta con haberla conectado una vez con otra seleccionada— y
entonces la búsqueda del webhook elige por orden de inserción: entrega a la primera, ve que no
tiene reglas y lo tira **sin escribir un solo error**, con la cadena impecable en la otra. Al
conectar se suelta de donde estuviera, y tanto los comentarios como los botones recorren todas
las empresas que tengan esa cuenta hasta dar con la que conoce la cadena.

Cuando algo de Instagram «no responde y no da error», mirar primero si el dato está duplicado
entre empresas. Y los descartes de `igProcesarComentario` dejan traza en los logs de Render:
buscar `IG` ahí es el primer sitio a mirar.
- El `companyId` viaja firmado en el `state` del OAuth: sin firma, cualquiera podría completar
  el flujo apuntando a otra empresa y quedarse con la cuenta de un cliente ajeno.

Las cadenas se editan en **Contenido → Automatización**, por empresa, y viven en
`app_data.ig.reglas`. La comparación de la palabra ignora mayúsculas y tildes.

### Las cadenas de mensajes

Una regla es una lista de `pasos`. El primero sale por respuesta privada al comentario; los
siguientes, por DM normal.

**El botón es lo que hace posible la cadena.** Instagram regala un solo mensaje por comentario,
pero cuando la persona **pulsa un botón** eso cuenta como interacción suya y abre la ventana de
24 h. Sin ese primer toque la conversación muere en el primer mensaje. Por eso ManyChat empieza
siempre con un botón: no es adorno.

**El estado no se guarda por persona.** El id del paso siguiente viaja dentro del `payload` del
botón (`f:<flujo>:<paso>`), así que al pulsarlo el mensaje ya trae escrito adónde ir. Guardar en
qué punto va cada conversación obligaría a limpiar sesiones colgadas para siempre.

- Tipos de paso: `mensaje` (texto + hasta 3 botones), `condicion`, `retraso` y `accion` (aviso
  interno al equipo, no sale nada a Instagram).
- **Condiciones**: `sigue`, `respondio`, `seguidores` (≥ N) y `verificado`. Ninguna es
  inventada: las tres primeras y la cuarta salen de campos reales del perfil
  (`is_user_follow_business`, `follower_count`, `is_verified_user`) salvo `respondio`, que se
  resuelve con `app_data.ig.contactos` comparando la fecha del último mensaje suyo contra la del
  nuestro — responder es escribir DESPUÉS de que le escribiéramos.
- **Una condición puede esperar antes de evaluarse** (`esperaMin`). Es lo que convierte
  «¿respondió?» en «¿no respondió en 3 horas?»: se agenda a sí misma en `pendientes` y al
  volver ya no espera (`sinEspera`), o se reprogramaría para siempre.
- **Si la comprobación falla, se va por la rama del «no».** Estas condiciones existen para
  condicionar algo a un requisito; dar por bueno un «sí» sin verificar lo regalaría ante
  cualquier fallo de red.
- **El retraso no usa `setTimeout`.** Render duerme el proceso y el plan gratuito se reinicia,
  así que la espera se guarda en `app_data.ig.pendientes` y la retoma `repasoCorto` cada 10 min.
  La granularidad real es de 10 minutos, no de segundos. Y si la espera pasa de las 24 h desde
  la última acción de la persona, el envío falla — es la ventana de Instagram, no un fallo
  nuestro.
- Límites de Instagram, no nuestros: **640** caracteres de texto, **3** botones, **20**
  caracteres por botón.
- La profundidad se corta a 8 saltos: dos condiciones que se apunten entre sí colgarían el
  proceso.
- Los comentarios llegan en `entry[].changes`; los botones pulsados, en `entry[].messaging`. Son
  dos formas distintas en el mismo webhook y hay que mirar las dos.
- Las reglas viejas de un solo `mensaje` se leen como una cadena de un paso; no hace falta
  migrar nada.

### Automatización atada a una pieza (reel/post) — se arma sola al publicar

Una cadena puede prepararse para una pieza concreta ANTES de que exista, y encenderse sola
cuando la pieza se publique. El problema que resuelve: la cadena necesita el `mediaId` real de
Instagram, y ese id solo existe DESPUÉS de publicar (y la publicación puede ser en 3 días). El
ciclo:

1. **Switch en Org Semanal** (`item.autoComentario`, solo en reel/post) marca que la pieza va con
   automatización. Viaja a la tarea (`task.autoComentario`) al confirmar.
2. **Contenido → Automatización** lista las piezas marcadas sin cadena como pendientes. Al
   preparar una (preset o a medida) la regla nace atada: `r.taskId` + **`r.pendienteMedia:true`**.
   El webhook **ignora** las reglas `pendienteMedia` (si no, dispararían como comodín sobre
   cualquier post desde que se dejan listas). La tarea pasa a `autoEstado:"lista"` y se avisa al
   equipo y al cliente.
3. **Portal del cliente**: el drawer muestra el estado (`en preparación` → `lista` → `activa`)
   leído de `task.autoEstado`.
4. **`igArmarPendientes()`** (en `repasoCorto`, cada 10 min): mira las reglas `pendienteMedia`
   cuya pieza ya se publicó (estado `publicado`, o su hora programada ya pasó). Busca el post
   recién salido en `me/media` (misma API que el webhook), le pega el `mediaId` a la regla y la
   suelta (`pendienteMedia:false`). Marca la tarea `publicado` + `autoEstado:"armada"` y avisa.
   Matching robusto: reel exige `VIDEO`, prefiere coincidencia de caption, excluye media ya
   armado (incl. dentro de la misma corrida, `usadosRun`), ignora posts fuera de la ventana. Si
   Zernio aún no publicó, no aparece media → no arma → reintenta. **Requiere que la cuenta esté
   conectada por Meta directo (comentario→DM), o sea Advanced Access para clientes; funciona hoy
   en cuentas propias.**

## Dominios y despliegue

Render, con despliegue automático al hacer push a `main`. La app responde en **dos dominios a
la vez**: el de Render y `portal.inmersiaperformance.cl`. La URL de retorno de Google se deriva
del dominio por el que entró la persona, **validada contra una lista blanca** en `server.js`
(confiar en la cabecera Host permitiría desviar el código de autorización). Si agregas un
dominio, hay que sumarlo ahí y en Google Cloud.

La web pública (`inmersiaperformance.cl`) es otro repo: `~/GitHub/inmersia-web`, HTML estático
en GitHub Pages. Tiene el botón "Portal" en la barra superior.

### El ping que mantiene despierto Render — no es tráfico raro

Render duerme el plan gratuito tras **15 minutos** sin tráfico y tarda **~1 minuto** en volver.
Dormido no es solo lento: **el proceso se detiene**, así que los `setInterval` de `repasoDiario`
y `repasoCorto` no corren y **los recordatorios por horario no salen** (ni se arma la
automatización al publicar — `igArmarPendientes` vive en `repasoCorto`). El aviso de "reunión en
una hora" no se manda si nadie abrió la app en los 15 minutos previos.

Por eso hay un cron externo (cron-job.org, job "INMERSIA — mantener despierto") que pega a
`/api/health` cada 10 min. **Ventana: 07:00–03:00 hora de Chile (apagado 03:00–07:00);** crontab
`*/10 0-2,7-23 * * *` en zona America/Santiago. Ese endpoint es el correcto: es público, solo
devuelve booleanos de configuración y no toca Supabase.

**Apunta al dominio directo de Render** (`app-equipo-inmersia-beta-0-01.onrender.com/api/health`),
NO al custom `portal.inmersiaperformance.cl`: el custom va por Cloudflare y cuando Render está
dormido/desplegando devuelve un 5xx rápido, que cron-job.org cuenta como fallo. El 10-ago-2026 el
job se había **auto-deshabilitado** por acumular fallos de ese tipo (Render llevaba días
durmiéndose); se reactivó, se cambió la URL al dominio directo y se movió la ventana. Si vuelve a
caerse, cron-job.org avisa por email ("cuando el cronjob se deshabilite por demasiados fallos"
está activo) — revisar spam.

La ventana no es capricho, es presupuesto: el tier gratuito da **750 h/mes por workspace** y al
agotarlas Render **suspende** el servicio hasta el mes siguiente.

```
24/7            744 h/mes (mes de 31 días)  → 6 h de margen: demasiado al filo
07:00 – 03:00   600 h/mes (20 h/día)        → 150 h de margen
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
- **Aislamiento por empresa en `/api/data` — YA CERRADO (server.js).** Antes `/api/data` traía las
  claves de TODAS las empresas y filtraba en el navegador: un cliente logueado recibía tareas,
  contratos, precios, pagos y prospectos de los demás, y podía sobrescribirlos. Ahora el servidor
  identifica al cliente por su email (equipo lleva `@`, cliente no; + mapa espejo `CLIENTES`) y:
  (a) en lectura solo le entrega SU empresa y SUS tareas (`scopeCliente`, resto de claves ni las
  ve); (b) en escritura solo le acepta `tasks`, y por **merge** —solo modifica campos de sus tareas
  ya existentes; no crea, borra ni reasigna de empresa, ni toca otra clave—. Si agregas un cliente
  en `INIT_USERS` (frontend), agrégalo también en `CLIENTES` (server.js); aun si lo olvidas, todo
  email sin `@` se trata como cliente y sin empresa resuelta NO ve nada (fail-closed). **Pendiente
  menor:** los endpoints `/api/ig/*` y `/api/social/*` toman `companyId` del request; un cliente
  podría consultar/editar la conexión o reglas IG de otra empresa (no sus datos de negocio). Cerrar
  forzando `companyId` = su empresa en esos handlers.
- **La cookie de sesión es UNA por navegador: entrar al portal de un cliente secuestra la del
  equipo.** `_iauth` no distingue pestañas. Al entrar como un cliente para probar su portal, la
  pestaña del equipo sigue pintando el panel de admin —el rol lo decide el frontend desde
  `localStorage.userEmail`— pero **cada petición viaja como ese cliente**: el servidor solo
  entrega su empresa (`scopeCliente`) y solo acepta su merge restringido. El 21-ago-2026 eso
  costó una tarde: borrar una pieza la quitaba de la pantalla, se recargaba y volvía, porque el
  merge del cliente es `actuales.map(...)` y **un map nunca elimina** — la baja se ignoraba y
  respondía 200. Se diagnosticó pidiendo `/api/data` desde la consola de la pestaña del equipo:
  devolvía 1 empresa y 2 tareas en vez de todas.
  - `GET /api/auth/me` dice quién eres según el servidor, y `App` lo contrasta al arrancar:
    si el rol no coincide o la sesión no existe, la app **se planta** (`SesionCruzada`) en vez de
    dejar trabajar sobre datos que no se van a guardar. Un email distinto con el mismo rol solo
    avisa por consola: entrar con el Gmail y figurar en el equipo con otro correo es normal, y
    dejar al equipo fuera sería peor que el problema.
  - El `POST /api/data/:key` de un cliente **rechaza con 409** el intento de dar de baja una
    pieza. Rechazar en voz alta es la diferencia entre un permiso y un agujero negro.
  - Para probar el portal de un cliente sin romper nada: ventana de incógnito o otro perfil de
    Chrome. En la misma ventana, siempre cerrar sesión al volver.
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
