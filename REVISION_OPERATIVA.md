# Revisión operativa de RASTREADOC

## Estado de la oficina y configuración

- El usuario confirmó Pro y respaldos disponibles en ambos proyectos. La captura
  de RASTREADOC muestra siete copias diarias; todavía no se probó una restauración.
- RASTREADOC pasó de Nano a Micro sin incremento en el precio de cómputo mostrado.
  El usuario confirmó que pudo consultar un expediente después del reinicio.
- El disco mostrado usa 0.27 GB de 2 GB asignados y anuncia expansión automática
  a 8 GB. No se aumentó manualmente el disco.
- Vercel usa Node 24.x según la pantalla revisada. El repositorio declara Next.js
  y `npm run build` en vercel.json; se indicó alinear el selector del panel.
- El despliegue revisado es Production/Current/Ready, rama main, commit
  4924d852470a971880645946c7cabe7063a2773b (merge de PR 70).
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

## Cambios publicados solo en la rama y el Preview de pruebas

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
permanente, la sincronización automática entre computadoras, las mejoras de
paginación/rapidez y la revisión de fechas de reportes quedan para otras etapas.

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

Las pruebas de navegador crean un servidor Next local con dirección y clave
ficticias, interceptan su API y bloquean destinos externos. Comprueban doble clic,
respuesta perdida, verificación con sesión expirada, corrección con conflicto y
bloqueo del escáner. La integración real también se comprobó manualmente con el usuario en
Supabase Free y el Preview; los resultados están registrados abajo.

En esta máquina el PostgreSQL aislado se obtuvo con índices Debian firmados y
paquetes verificados por APT, extraídos sin instalar nada en el sistema:
`/tmp/rastreodoc-pg-packages/root/usr/lib/postgresql/17/bin`.
Esa ruta temporal puede no existir en una máquina futura.

Resultados locales de esta entrega: 12 pruebas JavaScript, 33 de PostgreSQL y
6 de navegador aprobadas. Compilación correcta y lint sin errores, con una
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

## Revisión de estructura de producción pendiente

Ejecutar únicamente scripts/revision-produccion.sql en SQL Editor del proyecto
real vmmafjnhtluinmmjyigv. Es una sola consulta de metadatos, sin DDL ni DML y sin
leer expedientes. Fue probada dentro de una transacción READ ONLY en PostgreSQL.

La salida comprueba columnas/tipos, estatus del enum y triggers de creación,
sincronización e inmutabilidad del historial. Si hay faltantes o la actualización
ya figura presente, revisar el resultado antes de continuar. Este chequeo no
sustituye verificar el respaldo reciente ni autoriza instalar la migración.
Los cambios de esta revisión son documentación, consulta y pruebas; no alteran
el código de la app que el usuario acaba de validar.

## Instalación coordinada pendiente

1. Revisar la salida de scripts/revision-produccion.sql y confirmar que existe
   un respaldo reciente. Las pruebas funcionales en la base Free ya se confirmaron.
   No ejecutar todas las migraciones históricas: existe una que elimina expedientes.
2. Revisar el diff de codex/rastreadoc-pruebas contra main y preparar la versión
   exacta. La rama ya está en GitHub; main se confirmó sin cambios en 4924d85.
   Aún falta autorización para actualizar producción.
3. Con la oficina cerrada y sin escrituras pendientes, aplicar únicamente
   `supabase/migrations/20261110_atomic_document_operations.sql`.
4. Publicar inmediatamente la versión de la app que usa esa RPC. Entre ambos
   pasos, los clientes anteriores recibirán un aviso de actualizar y sus
   movimientos/correcciones serán rechazados antes de modificar datos.
5. Recargar las pestañas de todos los equipos. Comprobar acceso, lectura de un
   expediente y el flujo de escritura acordado antes de reabrir la operación.
6. Si falla la publicación, quitar solamente las dos guardias nuevas usando
   `supabase/rollback/20261110_atomic_document_operations_guards.sql` y restaurar
   el despliegue anterior. Esto conserva el historial y las confirmaciones ya
   guardadas; no elimina tablas ni revierte movimientos legítimos.

La migración crea funciones, dos triggers de guardia y una tabla de confirmaciones;
no modifica los movimientos anteriores. La app nueva requiere esa migración y
no recurre a guardados separados si la función no está disponible.

## Pendientes de respaldo y continuidad

- Probar una restauración en un proyecto separado, comparar conteos/relaciones y
  consultar un expediente conocido. Tener copias listadas no demuestra recuperación.
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

La rama de esta entrega es codex/rastreadoc-pruebas y está subida a GitHub.
No se ha fusionado con main ni aplicado la migración en producción.
