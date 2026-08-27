/* ═══ BRIEF DE CLIENTE — la definición, en un solo sitio ═══════════════════════════════════
   La cargan LAS DOS puntas: `brief.html`, que es el formulario público que rellena el cliente,
   y `index.html`, donde el equipo lo lee. Vive aparte justo por eso: escrito dos veces, se
   arregla una pregunta en un lado y en el otro se queda la vieja, y como el cliente responde en
   una copia y el equipo lee la otra, la diferencia no se nota hasta que falta un dato.

   Sale del documento «Brief de cliente — Inmersa SPA». Con dos cambios a propósito:
   · No está «Plan seleccionado». El plan de cada empresa ya vive en su ficha y es lo que calcula
     el cupo del mes: preguntarlo aquí abre la puerta a que digan dos cosas distintas.
   · La sección 07 no la ve el cliente. Son notas de venta del asesor —«cliente desconfiado»,
     «local de difícil acceso»— y el servidor ni siquiera acepta que lleguen desde el formulario.

   Tipos de campo: texto · larga (varios renglones) · una (elige una) · varias (elige las que
   quiera; `max` limita cuántas).                                                              */
(function (raiz) {

  const SECCIONES = [
    {
      n: "01", t: "Datos del negocio",
      d: "Lo básico para saber con quién estamos trabajando.",
      campos: [
        { k: "negocio", l: "Nombre del negocio o marca", tipo: "texto", req: true, ph: "Ej: Restaurant El Rincón del Chef" },
        { k: "contacto", l: "Nombre del dueño o contacto principal", tipo: "texto", req: true, ph: "Ej: Juan Pérez" },
        {
          k: "rubro", l: "Rubro", tipo: "una", req: true,
          op: ["Restaurant / Café", "Cabaña / Lodge / Hotel", "Tienda", "Turismo / Outdoor", "Servicios", "Otro"],
        },
        { k: "tipoNegocio", l: "Tipo de negocio", tipo: "una", op: ["Familiar", "PYME", "Individual"] },
        { k: "direccion", l: "Dirección o referencia", tipo: "texto", ph: "Dirección completa o una referencia para llegar" },
        { k: "ciudad", l: "Ciudad o sector", tipo: "una", op: ["Valle Las Trancas", "Chillán", "Otro"] },
        { k: "telefono", l: "Teléfono de contacto", tipo: "texto", req: true, ph: "+56 9 XXXX XXXX" },
        { k: "email", l: "Correo electrónico", tipo: "texto", req: true, ph: "correo@negocio.cl" },
        { k: "web", l: "Sitio web", tipo: "texto", ph: "https://www.negocio.cl — o déjalo vacío si no tienes" },
      ],
    },
    {
      n: "02", t: "Presencia digital actual",
      d: "Dónde estás hoy. Sirve para saber desde dónde partimos, no para juzgar nada.",
      campos: [
        { k: "redes", l: "Redes que tiene el negocio", tipo: "varias", op: ["Instagram", "Facebook", "TikTok", "YouTube", "LinkedIn", "Ninguna por ahora"] },
        { k: "ig", l: "Instagram", tipo: "texto", ph: "@nombre_negocio" },
        { k: "fb", l: "Facebook", tipo: "texto", ph: "Nombre de la página" },
        { k: "tiktok", l: "TikTok", tipo: "texto", ph: "@nombre_negocio" },
        { k: "seguidores", l: "Seguidores aproximados", tipo: "texto", ph: "Ej: Instagram 1.200 · Facebook 800" },
        {
          k: "frecuencia", l: "¿Con qué frecuencia publican hoy?", tipo: "una",
          op: ["Todos los días", "2 o 3 veces por semana", "1 vez por semana", "Ocasionalmente", "Casi nunca o nunca"],
        },
        {
          k: "agenciaAntes", l: "¿Han contratado marketing digital antes?", tipo: "una",
          op: ["Sí, con otra agencia", "Sí, lo hacíamos internamente", "No, nunca"],
        },
        { k: "experienciaAnterior", l: "Si fue que sí: ¿qué resultados tuvieron y por qué lo dejaron?", tipo: "larga", ph: "Cuéntanos cómo les fue. Lo que no funcionó nos sirve tanto como lo que sí." },
      ],
    },
    {
      n: "03", t: "El negocio y su cliente",
      d: "Lo que vendes y a quién. Es la parte que más cambia lo que publicamos.",
      campos: [
        { k: "ofrece", l: "¿Qué ofrece el negocio?", tipo: "larga", req: true, ph: "Los productos o servicios más importantes." },
        { k: "propuestaValor", l: "¿Qué te diferencia de la competencia?", tipo: "larga", req: true, ph: "¿Por qué alguien debería elegirte a ti y no al de al lado? ¿Qué tienes que los demás no?" },
        {
          k: "clienteIdeal", l: "¿Quién es tu cliente ideal?", tipo: "varias",
          op: ["Turistas nacionales", "Turistas extranjeros", "Familias locales", "Parejas o grupos de amigos", "Empresas y eventos corporativos", "Público joven (18-30)"],
        },
        { k: "clienteDetalle", l: "Descríbelo con más detalle", tipo: "larga", ph: "Edad, de dónde vienen, qué buscan, cómo te encuentran hoy." },
        {
          k: "temporada", l: "¿Cuándo es tu temporada alta?", tipo: "varias",
          op: ["Verano (dic–feb)", "Semana Santa y fiestas patrias", "Invierno (jun–ago)", "Todo el año parejo", "Depende de eventos o ferias"],
        },
        { k: "precioPromedio", l: "Precio promedio de tu producto o servicio", tipo: "texto", ph: "Ej: $15.000 el plato · $80.000 la noche" },
        { k: "ticketPromedio", l: "Cuánto gasta en promedio un cliente por visita", tipo: "texto", ph: "Ej: $25.000" },
      ],
    },
    {
      n: "04", t: "Objetivos",
      d: "Qué quieres que pase. Sin esto, publicar bonito no significa nada.",
      campos: [
        {
          k: "objetivos", l: "¿Qué quieres lograr?", tipo: "varias", max: 2, req: true,
          ayuda: "Elige un máximo de dos. Con más de dos objetivos a la vez, ninguno se cumple.",
          op: ["Que me conozca más gente", "Conseguir clientes nuevos", "Fidelizar a los que ya tengo", "Vender más directo", "Mejorar la imagen de la marca", "Empujar un producto o servicio concreto"],
        },
        { k: "plazo", l: "¿En cuánto tiempo esperas ver resultados?", tipo: "una", op: ["1 mes", "2 o 3 meses", "6 meses", "Largo plazo (más de un año)"] },
        { k: "metricaExito", l: "¿Qué resultado concreto sería un éxito para ti?", tipo: "larga", ph: "Dilo con tus palabras. Ej: «que me lleguen más reservas por Instagram»." },
        { k: "referentes", l: "¿Hay competidores o cuentas que te gusten?", tipo: "larga", ph: "Nombra una a tres, y qué te gusta de lo que hacen." },
      ],
    },
    {
      n: "05", t: "Identidad y contenido",
      d: "Con qué material contamos y cómo tiene que sonar la marca.",
      campos: [
        {
          k: "identidad", l: "¿Tienen identidad visual definida?", tipo: "una",
          op: ["Sí, tenemos logo y colores", "Tenemos logo, pero no nos convence", "Está en proceso", "No tenemos nada aún"],
        },
        {
          k: "material", l: "¿Qué material visual tienen ya?", tipo: "varias",
          op: ["Fotos del local o los productos", "Videos anteriores", "Logo en alta resolución", "Manual de marca", "Fotografías profesionales", "Nada por ahora"],
        },
        {
          k: "tono", l: "¿Cómo tiene que sonar la marca?", tipo: "varias", max: 2,
          op: ["Cercano y familiar", "Profesional y formal", "Divertido", "Aspiracional / premium", "Aventurero / outdoor", "Sofisticado / exclusivo"],
        },
        { k: "referenciasVisuales", l: "Colores, estilos o referencias que quieras usar (o evitar)", tipo: "larga", ph: "Paleta, estilo de las fotos, cuentas que te gusten." },
        { k: "restricciones", l: "¿Hay algo que NO se puede publicar?", tipo: "larga", ph: "Ej: no mostrar al personal, no publicar precios, no comparar con la competencia." },
      ],
    },
    {
      n: "06", t: "Cómo trabajamos juntos",
      d: "Lo práctico: por dónde te ubicamos y quién aprueba.",
      campos: [
        {
          k: "extras", l: "¿Te interesa algo de esto, aparte del plan?", tipo: "varias",
          op: ["Tarjeta de fidelización", "Rebranding / identidad visual", "Videos adicionales", "Reels adicionales", "Imágenes o historias adicionales", "Nada por ahora"],
        },
        { k: "canalContacto", l: "¿Por dónde te ubicamos?", tipo: "varias", op: ["WhatsApp", "Llamada", "Correo", "Reunión presencial", "Videollamada"] },
        { k: "horarioContacto", l: "Horario en que prefieres que te contactemos", tipo: "texto", ph: "Ej: lunes a viernes de 10:00 a 13:00" },
        { k: "diasVisita", l: "Días en que podemos ir a grabar o fotografiar", tipo: "texto", ph: "Ej: martes y jueves" },
        { k: "aprobadorNombre", l: "¿Quién aprueba el contenido antes de publicarse?", tipo: "texto", ph: "Nombre completo" },
        { k: "aprobadorCargo", l: "Su cargo o relación con el negocio", tipo: "texto", ph: "Ej: dueño, encargada de comunicaciones" },
        {
          k: "nivelRevision", l: "¿Cuánto quieres revisar?", tipo: "una",
          op: ["Quiero revisar y aprobar todo", "Solo lo importante", "Confío en el criterio de INMERSIA", "Por definir"],
        },
      ],
    },
  ];

  // Sección 07 del documento. NO viaja al formulario del cliente y el servidor la rechaza si
  // llega desde ahí: son notas del asesor sobre el cliente, no del cliente sobre sí mismo.
  const INTERNA = {
    n: "07", t: "Observaciones del asesor",
    d: "Uso interno. El cliente no ve nada de esto.",
    campos: [
      { k: "notasAsesor", l: "Notas del levantamiento", tipo: "larga", ph: "Impresiones del local, del proceso de venta, contexto que no cabe en las respuestas." },
      { k: "desafios", l: "Desafíos detectados", tipo: "larga", ph: "Ej: sin identidad visual, competencia fuerte, cliente desconfiado, local de difícil acceso." },
      { k: "proximosPasos", l: "Próximos pasos acordados", tipo: "larga", ph: "Ej: enviar propuesta, agendar visita, confirmar fecha de inicio." },
    ],
  };

  // Las claves que el cliente puede escribir. El servidor filtra por esta lista, así que una
  // pregunta que no esté aquí no entra por más que alguien la mande a mano.
  const CLAVES_CLIENTE = SECCIONES.reduce((a, s) => a.concat(s.campos.map(c => c.k)), []);
  const CLAVES_EQUIPO = INTERNA.campos.map(c => c.k);

  const API = { SECCIONES, INTERNA, CLAVES_CLIENTE, CLAVES_EQUIPO };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else raiz.BRIEF = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
