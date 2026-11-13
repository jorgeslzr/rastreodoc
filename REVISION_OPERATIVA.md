# Revisión operativa de RASTREADOC

## Siguiente entrega: eliminación desde Archivados

El 13 de noviembre el usuario descartó la actualización entre computadoras y
solicitó el botón de eliminación definitiva. Se preparó la eliminación individual
del documento archivado y su historial, con confirmación escrita y verificación
de respuestas perdidas. El expediente y otros documentos se conservan. Véanse
el alcance, la migración y los pasos de revisión en
[ELIMINACION_DEFINITIVA.md](ELIMINACION_DEFINITIVA.md).
El usuario confirmó que instaló la migración en la base Free de pruebas y obtuvo
los tres resultados `true`. En Preview confirmó la eliminación del documento
ficticio BORRAR-PRUEBA y, después de recargar, la conservación del expediente y
del historial de otro documento. La entrega está preparada; falta aprobar la
instalación en la base real y la publicación en producción. La copia independiente
de Supabase al servidor sigue sin considerarse configurada hasta aclarar qué
respaldo revisó el usuario. El diseño en teléfonos físicos era una revisión
adicional, diferente de las pruebas automatizadas con emulación.

## Estado al 12 de noviembre de 2026

- El usuario confirmó Pro y respaldos disponibles en ambos proyectos. El 12 de
  noviembre se restauró un respaldo real en un proyecto temporal independiente.
  Se pudieron consultar 1071 expedientes, 1786 documentos y 4795 movimientos;
  el usuario confirmó un expediente conocido, su tipo, estatus e historial, y la
  presencia de la función de guardado y sus dos protecciones. El usuario confirmó
  después la eliminación de la copia temporal para detener sus cargos.
- RASTREADOC pasó de Nano a Micro sin incremento en el precio de cómputo mostrado.
  El usuario confirmó que pudo consultar un expediente después del reinicio.
- El disco mostrado usa 0.27 GB de 2 GB asignados y anuncia expansión automática
  a 8 GB. No se aumentó manualmente el disco.
- Vercel usa Node 24.x según la pantalla revisada. El repositorio declara Next.js
  y `npm run build` en vercel.json; se indicó alinear el selector del panel.
- La primera entrega se publicó en main el 11 de noviembre, commit
  e9f7e590c87a603c75bc8ebe149fb842ae789b3c, después de instalar la migración de
  guardado atómico con la oficina sin uso. El usuario confirmó acceso, consulta
  de un expediente real e historial. Al iniciar esta segunda entrega, main
  continuaba en ese commit. La mejora de alta y QR se publicó después en
  20f3b3898b7e4feea55e4b0574827bd5b5b236e6; se comprobaron HTTP 200, los ocho
  scripts públicos, sus señales nuevas y el backend real. El usuario confirmó
  después la recarga y consulta de un expediente e historial en producción.
- La mejora de mensajes de acceso y recuperación de sesión se publicó después
  en 5b2261bc2c64fdef69744ef99ac56031f11452f5. Se comprobaron HTTP 200, los ocho
  scripts públicos, sus señales nuevas y el backend real. El usuario confirmó
  después el acceso y consulta en producción. La cuarta entrega, de fechas de
  reportes, se publicó en 65c11108ad012696575c431a3c7c60976e65e05e. Sus once
  señales públicas y el backend real se verificaron; el usuario confirmó el
  horario y los documentos de un expediente conocido en Reportes de producción.
- La mejora de carga completa se publicó en
  31542aa3be742729b177ce37649cc9b957471ce1. Se verificaron sus quince señales
  públicas y el backend real; el usuario confirmó después el panel y la consulta
  de un expediente conocido con sus documentos en producción.
- La sexta entrega, de altas de expedientes y avisos junto a Guardar expediente,
  se publicó en ece47bd469cff0ab4370145897ec7b82e028f21c. Se verificaron sus veinte
  señales públicas y el backend esperado. El usuario confirmó los avisos en
  producción antes de solicitar el rediseño visual.
- Se comprobó en sus archivos públicos que la app incorpora 8192 para el indicador
  de almacenamiento y la dirección del proyecto Supabase esperado. Ese indicador
  es una referencia del plan, no una medición del espacio libre físico del disco.
- Las entradas generales de Supabase siguen compartidas entre Production y
  Preview. Se crearon tres overrides exclusivos para codex/rastreadoc-pruebas:
  URL, clave publicable y clave de servidor del proyecto Free. El usuario confirmó
  acceso y escrituras sobre los documentos ficticios. Otras ramas Preview siguen
  necesitando revisar su aislamiento antes de probar escrituras.
- Los dominios del entorno de Codex están habilitados y se verificó conectividad.
  No se han inspeccionado los valores privados ni conectado credenciales de
  administración al entorno.

## Protecciones publicadas en producción el 11 de noviembre

- Mensaje de boleta consistente con el estado confirmado por servidor.
- Error de consulta QR diferenciado de documento ausente.
- Reporte anterior conservado si falla el refresco después de guardar; respuestas
  antiguas no reemplazan el resultado de operaciones posteriores.
- Una sola RPC `save_document_operation` para registrar movimientos o corregir
  etiqueta y estado. Una falla revierte toda la operación.
- Comparación de estado, fecha exacta del servidor y etiqueta para detectar otra
  modificación antes de guardar. Cada documento se bloquea durante la transacción.
- ID persistente de operación en la base: verificar una respuesta perdida usa el
  mismo ID y argumentos. La verificación devuelve el estado actual del documento.
- Una sesión expirada durante la verificación conserva la solicitud pendiente;
  no afirma que el primer intento no se guardó.
- Validación de boleta en servidor, excepción ISAI y clasificación de reingreso
  por historial. Una lectura repetida no crea otro movimiento del mismo estado.
- Captura QR, selector de modo y campos bloqueados mientras se procesa un guardado;
  al terminar, el foco vuelve al lector. Verificación accesible dentro de corrección.
- Guardias de base impiden que una pestaña antigua inserte movimientos o cambie
  etiqueta/estado/fecha directamente. Archivado y restauración conservan su flujo.

No se modificaron perfiles ni políticas de roles existentes. La eliminación
permanente, la sincronización automática entre computadoras y la paginación
quedan para otras etapas. Las fechas de reportes se corrigen en la cuarta entrega.

## Segunda entrega: alta y QR, publicada en producción

El usuario identificó lentitud al dar de alta documentos y al generar/imprimir
QR. Esta entrega se enfoca en esos pasos y no necesita migraciones ni cambios
de infraestructura:

- Abrir Alta dentro de la aplicación conserva los datos ya cargados. El acceso
  directo a /alta sigue disponible. Renovar el token de la misma cuenta tampoco
  vuelve a cargar toda la información.
- Un alta con tipo y dependencia ya cargados usa sus IDs locales y hace solamente
  la escritura del documento; elimina las dos consultas de catálogo y la recarga
  del historial de reportes que antes se hacían por documento.
- El documento nuevo lleva un UUID de cliente. Se bloquea el doble clic y, ante
  una respuesta incierta, Verificar alta consulta/reutiliza el mismo UUID y los
  mismos datos. El PK existente impide otro documento o movimiento inicial.
  La verificación pendiente se conserva en la pestaña; antes de recargar/cerrar
  el navegador avisa. No se promete persistencia si se ignora ese aviso.
- El formulario conserva la captura mientras el resultado sea incierto. Solo
  muestra el documento guardado y habilita su QR después de confirmarlo.
- El alta ofrece Ver e imprimir QR junto al último documento guardado, evitando
  una búsqueda adicional.
- La biblioteca QR se precarga en tiempo ocioso. La caché de imágenes reutiliza
  generaciones en curso y conserva como máximo 64 entradas en memoria.
- La ventana de impresión por lote se abre desde el clic y muestra preparación.
  Se mantienen el orden de las etiquetas y los QR RDOC originales, de 420 px,
  margen 1 y corrección H, con papel de 40 × 30 mm.
- Se espera a decodificar todas las imágenes antes de imprimir. Una imagen que
  falla produce un mensaje y no dispara la impresión de un lote incompleto.
  Un bloqueo de ventanas emergentes recibe instrucciones visibles de reintento.
- Los cruces de documentos con boletas se indexan una vez y se memoizan; ya no
  se busca en todo el historial por cada documento y cada tecla de captura.

El usuario confirmó estas pruebas manuales en el Preview de la rama configurada,
con el código 60da4e4 y registros ficticios del proyecto Free:

- El alta mostró Ver e imprimir QR junto al documento guardado.
- La impresión individual abrió rápido y salió completa y legible, según su
  confirmación cualitativa. No se midió un tiempo numérico.
- Buscar mostró un único documento con el identificador de prueba, y su Historial
  contenía un único movimiento inicial Listo para enviar.
- Se creó otro documento de tipo diferente y se imprimieron juntos: el usuario
  confirmó dos etiquetas completas, una CERTIFICADO y otra ISAI.

El usuario inicialmente no tenía lector físico en esa computadora; después
confirmó «listo si se pudo escanear». Queda registrada la lectura física como
exitosa, sin atribuirle un tiempo medido ni movimientos nuevos. El usuario
autorizó publicar esta entrega y confirmó la consulta en producción. La prueba
local de PDF valida geometría y páginas, sin medir el tiempo físico de la impresora.

## Tercera entrega: mensajes de acceso y recuperación de sesión

Validada en el Preview aislado del proyecto Free:

- El mensaje de usuario/contraseña incorrectos se reserva para errores de
  credenciales confirmados. Los fallos de conexión, servicio y límite de intentos
  reciben mensajes distintos y accionables, sin exponer detalles internos.
- Las solicitudes de Auth tienen un límite de 15 segundos, incluido el cuerpo
  de la respuesta. Las esperas de la interfaz terminan a los 20 segundos y
  liberan los controles aun si una operación del SDK sigue pendiente.
- Recuperar una sesión maneja errores y permite Reintentar sesión. Una respuesta
  antigua no reemplaza un acceso o una recuperación posteriores. El suscriptor
  de Auth conserva callbacks síncronos para evitar bloqueos de sesión.
- El inicio de sesión bloquea doble clic y campos durante la solicitud. Conserva
  los datos si falla y borra la contraseña del formulario después de confirmar
  el acceso. Los avisos de Auth se separan de los avisos de operaciones.
- El fetch especial limita únicamente rutas /auth/v1/. Las escrituras de datos
  mantienen su cuerpo, headers y señal de cancelación existentes; conservan sus
  protocolos de guardado incierto y verificación.
- La recuperación de una cookie con sesión expirada y servicio temporalmente
  caído se probó en navegador: ofrece reintentar y se recupera al volver el
  servicio, sin pedir de nuevo la contraseña.

El usuario confirmó en Preview el mensaje correcto al introducir una contraseña
incorrecta y que Ingresar vuelve a habilitarse. Después confirmó acceso con la
contraseña correcta, sesión conservada tras Ctrl+F5 y consulta de PRUEBA-001.
Estas pruebas manuales corresponden al código cf8f24c.

Esta entrega no cambia roles, claves, variables o esquema de Supabase. Después
de validar Preview, el usuario autorizó publicarla. Se publicó en main como
5b2261b y se verificaron sus archivos públicos y el backend de producción.
El usuario confirmó después el acceso y consulta normales.

## Cuarta entrega: fechas y horas de la oficina

El filtro de reportes tomaba el día UTC del último movimiento, aunque la oficina
usa el horario de la Ciudad de México. Por ejemplo, un movimiento a las 23:30
del 11 de noviembre podía aparecer al filtrar el 12. Esta entrega usa
America/Mexico_City para el día del filtro y para las fechas mostradas:

- Pantalla, Excel e impresión/PDF comparten el mismo día y hora. El nombre del
  archivo exportado también usa el día de la oficina. Expediente, historial,
  escáner y archivados muestran esa misma zona, con horario de 24 horas.
- Desde y Hasta incluyen el día completo. Se conservan los filtros abiertos y
  los documentos sin boleta. El reporte sigue mostrando el estado actual de
  cada documento y la fecha de su último movimiento.
- Un rango invertido muestra «La fecha Desde no puede ser posterior a Hasta.»
  y bloquea las tres salidas del reporte hasta corregirlo.
- Las fechas del reporte se calculan al abrir Reportes y se reutilizan al
  filtrar. Dar de alta y escribir en el formulario no formatean todo el catálogo.
- No se cambian los timestamps guardados, su precisión, las comparaciones de
  concurrencia ni los cálculos de tiempo transcurrido. No hay SQL, cambios de
  claves, variables, roles ni dependencias.

El usuario confirmó Ready del Preview dbdeafd y el texto de horario de la Ciudad
de México. Confirmó que Desde 12/11/2026 y Hasta 11/11/2026 muestran el aviso y
deshabilitan las tres salidas. Con ambas fechas en 12/11/2026 y expediente
PRUEBA-001, confirmó documentos del día y botones habilitados. Después confirmó
los mismos documentos y fechas/horas en pantalla, Excel y Ver PDF.

Después de validar Preview, el usuario autorizó publicar la cuarta entrega. Se
envió el SHA fijo 65c1110 a main mediante push normal y el sitio sirvió sus once
señales públicas, ocho scripts correctos y el backend real. El usuario confirmó
después el horario de Ciudad de México y documentos de un expediente conocido
en Reportes de producción. No requirió migraciones de Supabase.

## Quinta entrega: carga completa y reintento

La carga inicial aplicaba resultados vacíos cuando una consulta devolvía error.
Además, la captura y los reportes podían abrirse antes de terminar de cargar.
Esta entrega conserva las consultas simultáneas y cambia cómo se presentan sus
resultados:

- Mientras faltan consultas, se muestra Cargando información. Los contadores,
  formularios y reportes se abren al completar todos los datos requeridos.
  Así no se captura sobre catálogos incompletos ni se confunde una consulta
  fallida con un documento ausente o un resumen de cero documentos.
- Si falla una consulta o una página posterior, se descarta el conjunto parcial
  y se ofrece Reintentar carga sin volver a iniciar sesión. Una tabla realmente
  vacía sigue siendo válida; una respuesta ausente o inválida no lo es.
- La carga tiene un límite total de 20 segundos, incluidas las páginas y los
  reintentos de lectura del SDK. Al fallar, expirar o salir se cancelan sus
  lecturas. Una respuesta antigua no reemplaza la carga nueva.
- El estado se asocia al usuario, correo e intento actuales. La renovación del
  token no recarga los catálogos; cerrar sesión invalida la carga anterior.
- La selección de compatibilidad de documentos se reserva a errores de columna
  opcional (42703 y PGRST204). Los fallos de conexión/servicio no se transforman
  en una consulta reducida con datos de escritura o catálogos ausentes.
- El indicador opcional de espacio maneja errores y límite de espera por
  separado; su fallo no bloquea los datos principales.
- No hay cambios SQL, infraestructura, claves, roles, dependencias ni protocolos
  de escritura. Se conserva la verificación de guardados inciertos.

El usuario confirmó Ready del Preview 0f93f50. Después de indicarle recargar el
alias fijo y entrar con pruebas, confirmó el panel y los mismos documentos de
PRUEBA-001 en Buscar. En Alta confirmó el expediente y la dependencia REGISTRO
PÚBLICO al elegir CERTIFICADO. En Reportes confirmó los mismos documentos de
Buscar, con sus fechas y horas de último movimiento.

Después de validar Preview, el usuario autorizó publicar esta quinta entrega.
Se envió el SHA fijo 31542aa a main mediante push normal. El sitio sirvió sus
quince señales públicas, ocho scripts correctos y el backend real. El usuario
confirmó después el panel y la consulta de un expediente conocido con sus
documentos. Los errores de red y esperas se verificaron en pruebas automatizadas;
no se interrumpió la conexión de la oficina para probarlos.

## Sexta entrega: alta de expedientes verificable

La base ya impide números repetidos, pero una respuesta perdida al crear un
expediente dejaba la captura sin resolver. Un nuevo intento podía responder
«ya existe» sin incorporarlo a la búsqueda hasta recargar. Esta entrega conserva
el número capturado y un UUID propio hasta confirmar el resultado:

- Un alta normal hace una sola inserción. El expediente se incorpora una vez
  al catálogo local y se selecciona para agregar documentos sin recargar.
- Los avisos del expediente se muestran debajo de Guardar expediente, en la
  columna izquierda. La verificación pendiente aparece en esa misma zona;
  al cambiar de vista conserva su aviso y acción accesibles.
- Una solicitud en curso bloquea dobles envíos y la captura de documentos o
  lectura de QR. Si el guardado es incierto, ofrece Verificar expediente y
  conserva los campos hasta resolverlo. La verificación sigue accesible al
  cambiar de vista; el navegador avisa antes de abandonar una solicitud pendiente.
- Verificar primero busca el UUID original. Si no aparece, reintenta el mismo
  UUID y número; las restricciones de base impiden un expediente adicional.
- Un conflicto por número busca el registro mediante igualdad citext de la
  base, conserva su escritura original y lo selecciona con el mensaje «ya existe».
  No sobrescribe expedientes ni afirma haber creado uno que ya estaba guardado.
- Cada alta/verificación tiene un límite total de 20 segundos. Una respuesta
  antigua no borra la verificación pendiente ni modifica un intento posterior.
  Un fallo de lectura o autenticación conserva la solicitud incierta. La denegación
  de un reintento no demuestra que el primer intento haya sido revertido.
- Solo una reversión conocida de la primera inserción permite corregir la
  captura con un UUID nuevo. Un resultado incompleto sigue pendiente.
- La solicitud se conserva en memoria de la pestaña; no se promete persistencia
  después de ignorar el aviso de cierre/recarga. No hay migraciones ni cambios
  de variables, claves, roles, infraestructura o dependencias.

El usuario confirmó en el Preview 3084270 que PRUEBA-EXP-12NOV se guarda, se
limpia el campo superior y queda seleccionado para agregar documentos. Al
capturarlo en minúsculas confirmó el aviso «ya existe» y la selección del mismo
expediente. Después pidió colocar los avisos debajo de Guardar expediente.
Confirmó esa ubicación en el Preview 5d0e498 al volver a capturar el mismo
expediente y autorizó publicar la entrega con «publicala de una vez».
Se publicó ece47bd mediante push normal, se verificó la nueva versión pública y
el usuario confirmó después «Listo, ya aparecen» sobre los avisos en producción.

## Séptima entrega: rediseño visual

El usuario pidió un rediseño completo basado en su referencia, conservando
funciones, campos, permisos, rutas, procesos y QR. Se reutilizan Next.js, React
y CSS; los componentes de presentación están separados de los manejadores de
negocio existentes. La descripción y archivos están en REDISENO_VISUAL.md.

Se aplican la paleta grafito/blanco/gris cálido/dorado, menú lateral, cabecera,
tarjetas, iconos y formularios a las nueve secciones. Los indicadores usan datos
existentes; el buscador conserva el alcance de Buscar y la campana representa
el seguimiento vencido existente. No se agregan procesos de notificación ni
generación de reportes, y se conserva la tabla con todos sus campos.

El usuario confirmó la apariencia de Reportes en Preview frente a la referencia
y el 13 de noviembre autorizó publicar el rediseño en el dominio de la oficina.
Se aprobaron 67 pruebas JavaScript y 45 de navegador. Las comprobaciones nuevas
recorren las nueve secciones y los cuatro perfiles, comprueban indicadores reales,
búsqueda existente y navegación responsive sin desbordamiento ni pérdida de
borradores. Tras el último ajuste de cuadrícula se repitieron los cuatro casos
visuales. Lint sin errores y la advertencia previa de imagen QR. No se repitió
PostgreSQL al no modificarse SQL; las comprobaciones previas permanecen registradas.
La compilación de producción es correcta y conserva las rutas existentes.

## Validación reproducible

Desde /workspace/rastreodoc:

```bash
node --test tests/*.test.mjs
PG_BIN=/ruta/a/postgresql/bin python tests/document-operations-db.py
python tests/document-operations-browser.py
npm run lint
npm run build
```

Las pruebas SQL usan PostgreSQL real en un cluster efímero, accesible solo por
socket privado, con usuarios y registros ficticios. Inicializan un esquema de
prueba, aplican solamente la migración nueva y prueban también su repetición.
Nunca toman una URL de Supabase ni reutilizan una base existente.

Las pruebas de navegador requieren Playwright para Python, pypdf y Chromium.
Crean un servidor Next local con dirección y clave ficticias, interceptan su API
y bloquean destinos externos. Comprueban guardados, respuestas perdidas,
correcciones, bloqueo del escáner, alta sin consultas extra, catálogo manual,
impresión individual/lote y bloqueo/fallo de imágenes. Los PDF generados verifican
una página de 40 × 30 mm por etiqueta seleccionada. La integración real de la
primera entrega también se comprobó con el usuario en Supabase Free y Preview.

En esta máquina el PostgreSQL aislado se obtuvo con índices Debian firmados y
paquetes verificados por APT, extraídos sin instalar nada en el sistema:
`/tmp/rastreodoc-pg-packages/root/usr/lib/postgresql/17/bin`.
Esa ruta temporal puede no existir en una máquina futura.

Para alta y QR se aprobaron 25 pruebas JavaScript, 34 de PostgreSQL y 13 de
navegador, además de compilación y lint. Para mensajes de acceso se aprobaron
37 pruebas JavaScript y 20 de navegador, incluidos los flujos anteriores de
alta, movimientos y QR. Para fechas de reportes se aprobaron 45 pruebas
JavaScript y 25 de navegador. Incluyen medianoche, cambio de mes/año y horario
histórico, computadoras en UTC y Los Ángeles, filtros inclusivos y abiertos,
rango invertido, coincidencia entre pantalla/CSV/impresión e historial, y alta
sin formatear las fechas de todo el catálogo. La compilación es correcta.
Las pruebas de PostgreSQL no se repitieron en estas dos entregas porque no
modifican SQL; se conserva su resultado anterior. Lint sin errores, con la
advertencia existente sobre la imagen del QR.

Para carga completa se aprobaron 53 pruebas JavaScript y 33 de navegador.
Los casos nuevos incluyen la última consulta demorada, fallos de conexión y de
catálogo, respuesta inválida, error tras mil filas en la segunda página,
reintento completo, deadline y respuesta antigua, salida durante la carga,
compatibilidad de columnas opcionales y recuperación automática de un 503
transitorio. Se mantienen los reintentos reales del SDK (1, 2 y 4 segundos);
las esperas de esas pruebas contemplan ese tiempo. Lint no tiene errores y
conserva la advertencia previa. PostgreSQL no se repitió, ya que no cambia SQL.
La compilación Next 16.4.6 es correcta con variables públicas ficticias.

Para alta de expedientes se aprobaron 67 pruebas JavaScript, 36 de PostgreSQL y
41 de navegador. Las dos pruebas SQL nuevas confirman inserción con UUID propio,
reintento sin segunda fila y unicidad citext ante diferencias de mayúsculas. Las
pruebas de navegador incluyen doble clic, incorporación inmediata al formulario
de documentos, respuesta perdida, verificación tras cambiar de vista, aviso de
recarga, reintento con la misma solicitud, número existente dentro/fuera del
catálogo local, reversión confirmada, autenticación fallida y respuesta tardía.
Se mantuvieron aprobados todos los flujos anteriores. Lint sin errores, con la
advertencia previa de la imagen QR. Las pruebas usan datos ficticios en PostgreSQL
local y en la API interceptada del navegador, sin escribir en Supabase. La
compilación Next 16.4.6 es correcta con variables públicas ficticias.

Después de reubicar los avisos se repitieron diez casos de navegador: los ocho
de expedientes y los flujos de alta de documento/QR y corrección. Todos pasaron;
se revisó además una captura del aviso debajo de la tarjeta izquierda. No se
repitieron los tests de protocolo ni PostgreSQL, cuyos archivos no cambian.

## Proyecto Supabase de pruebas

El usuario confirmó que creó una organización Free y mostró el nuevo proyecto
Healthy, con dirección distinta de la oficina. Confirmó la ejecución del SQL
de preparación, la creación del usuario y su perfil, y la integración con Preview.

Para generar la preparación desde el esquema actual:

```bash
node scripts/generate-test-project-setup.mjs > /tmp/rastreadoc-pruebas.sql
```

El archivo se ejecuta únicamente en SQL Editor del proyecto de pruebas nuevo.
Se detiene antes de crear objetos si encuentra tablas en public o usuarios de
aplicación existentes. Incluye la RPC nueva, los catálogos y datos ficticios:
un expediente PRUEBA-001, dos documentos y sus dos movimientos iniciales.
No crea usuarios ni lleva contraseñas, claves o datos de la oficina.
El usuario confirmó que creó el usuario de pruebas en Authentication. Para
asignarle su perfil, ejecutar scripts/test-project-profile.sql en SQL Editor de
ese mismo proyecto. El script comprueba los marcadores ficticios y la confirmación
del correo antes de crear pruebas/admin; conserva perfiles existentes diferentes.
No incluye contraseñas ni modifica usuarios de Authentication. El usuario confirmó que
la ejecución terminó y se creó el perfil de pruebas.

## Pruebas manuales confirmadas por el usuario en Preview

Aplicación con los cambios de 8c3c246 y base Free independiente. El usuario
confirmó los siguientes resultados; no se hicieron estas pruebas en producción:

- Acceso con pruebas y consulta de PRUEBA-001, con dos documentos ficticios.
- Envío del certificado con B-PRUEBA-001: 2 movimientos.
- Rechazo: 3 movimientos. Repetir el mismo QR en RECHAZADO fue rechazado y mantuvo 3.
- Listo para enviar y nuevo envío B-PRUEBA-002: REINGRESADO, 5 movimientos.
- Corrección conjunta de etiqueta y estatus a AUTORIZADO: 6 movimientos y nota de corrección.
- Dos formularios abiertos sobre la misma versión: A guardó RECHAZADO; B recibió
  conflicto y no sobrescribió A. El historial mantuvo 7 movimientos.
- ISAI sin boleta: ENVIADO con 2 movimientos, sin exigir boleta.

Para evitar abrir un despliegue anterior se usa el alias de la rama:
https://rastreodoc-git-codex-rastreadoc-pruebas-jasg.vercel.app/
La incidencia de acceso se resolvió para el usuario al entrar por este alias;
no se pudo inspeccionar la configuración del enlace inmutable que fallaba.

## Revisión e instalación de producción realizadas el 11 de noviembre

La consulta de solo lectura scripts/revision-produccion.sql devolvió las cuatro
comprobaciones de compatibilidad en true y la función nueva ausente. El usuario
mostró el respaldo del 11 de noviembre a las 09:34:44 UTC y confirmó que la
oficina había dejado de usar el sistema.

Se aplicó únicamente supabase/migrations/20261110_atomic_document_operations.sql,
acompañada por recarga del esquema y tres verificaciones de metadatos. El usuario
confirmó función y dos protecciones en true. Se publicó e9f7e59 mediante un push
normal a main y se verificaron HTTP 200, la RPC nueva en el JS público y la URL
del backend de producción. El usuario confirmó acceso y lectura del expediente
e historial; se indicó Ctrl+F5 en cada equipo antes de reanudar la oficina.

No se utilizó la reversión. Se conserva el archivo
supabase/rollback/20261110_atomic_document_operations_guards.sql para retirar solo
las dos guardias si fuera necesario volver a la app anterior, preservando datos.
No ejecutar todas las migraciones históricas: existe una que elimina expedientes.

La migración crea funciones, dos triggers de guardia y una tabla de confirmaciones;
no modifica los movimientos anteriores. La app nueva requiere esa migración y
no recurre a guardados separados si la función no está disponible.

## Pendientes de respaldo y continuidad

- La restauración de base se probó con el respaldo del 12 de noviembre a las
  09:34:41 UTC. Los conteos y la muestra consultada no constituyen una comparación
  exhaustiva de todos los registros. No se probó levantar la app completa con
  Auth/Storage sobre esa copia; esos servicios requieren configuración adicional.
- Definir cuánto trabajo puede perderse entre respaldos diarios y si hacen falta
  copias más frecuentes o PITR, con su costo adicional.
- Verificar si el segundo sistema usa Supabase Storage. Los archivos de Storage
  necesitan respaldo aparte de la base de datos.
- La copia externa queda pospuesta por instrucción del usuario. La oficina
  tiene un servidor accesible por QuickConnect que se respalda en otro cada
  noche, alrededor de las 11 p. m. según su estimación. No se verificaron modelo,
  sistema operativo ni horario exacto, y no se configuró una exportación.
  Los respaldos diarios Pro de Supabase continúan; no reabrir esta etapa hasta
  que el usuario la retome.

## Proyectos

- Aplicación: https://rastreadoc.not131.com.mx/
- Vercel: https://vercel.com/jasg/rastreodoc
- Supabase: https://supabase.com/dashboard/project/vmmafjnhtluinmmjyigv

Las seis primeras entregas están publicadas en main hasta ece47bd. La séptima se
desarrolla en codex/rediseno-visual-rastreadoc y se valida usando codex/rastreadoc-pruebas,
que conserva los overrides del proyecto Free. No necesita ejecutar migraciones.
