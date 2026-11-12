# Revisión operativa de RASTREADOC

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
  continúa en ese commit.
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
permanente, la sincronización automática entre computadoras, la paginación y la
revisión de fechas de reportes quedan para otras etapas.

## Segunda entrega: alta y QR, para validar en Preview

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

Pendiente de esta entrega: validación en el Preview de la rama configurada y
con la impresora/lector reales del usuario antes de publicar en main. La prueba
de PDF verifica geometría y páginas; no mide el tiempo físico de la impresora.

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

Resultados locales de esta entrega: 25 pruebas JavaScript, 34 de PostgreSQL y
13 de navegador aprobadas. Compilación correcta y lint sin errores, con una
advertencia existente sobre la imagen del QR.

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
- Preparar una copia externa y su proceso de comprobación.
- La autenticación conserva mensajes genéricos y carece de límites de espera
  explícitos para getSession/signIn; la revisión de código detectó ese pendiente,
  pero no se estableció como causa de la incidencia de acceso y no se cambió en
  esta entrega de guardados.

## Proyectos

- Aplicación: https://rastreadoc.not131.com.mx/
- Vercel: https://vercel.com/jasg/rastreodoc
- Supabase: https://supabase.com/dashboard/project/vmmafjnhtluinmmjyigv

La primera entrega está en producción en e9f7e59. La segunda se desarrolla en
codex/alta-y-qr-rapidos y se valida usando codex/rastreadoc-pruebas, que conserva
los overrides del proyecto Free. Su publicación en main queda pendiente de la
prueba del usuario; no requiere volver a ejecutar la migración de guardados.
