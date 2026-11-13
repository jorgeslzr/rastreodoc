# Eliminación individual de documentos archivados

Entrega preparada y autorizada para producción el 13 de noviembre de 2026.
La versión anterior de producción es `8daad15`.
La actualización entre computadoras se descartó por indicación del usuario.

## Comportamiento

- Desde **Archivados**, administradores y supervisores ven **Eliminar definitivamente**.
  Se conservan los roles existentes y la opción Restaurar.
- La confirmación muestra expediente, tipo, identificador, dependencia y código
  del documento. Exige escribir exactamente `ELIMINAR`. Cancelar o Escape antes
  de enviar no escriben en la base de datos.
- Una sola transacción elimina el documento seleccionado, sus movimientos y sus
  confirmaciones de guardado. Conserva el expediente, otros documentos, usuarios
  y catálogos. El QR eliminado deja de encontrar un documento activo.
- Una constancia privada mínima conserva ID de solicitud y documento, actor,
  fecha, hash y cantidad de movimientos eliminados. No conserva etiquetas,
  boletas, notas ni el contenido del historial. Permite confirmar una respuesta
  perdida sin repetir la eliminación.
- El servidor exige que el documento siga archivado con la misma fecha exacta,
  último movimiento y etiqueta. La eliminación de un documento restaurado o
  cambiado se rechaza. El historial sigue protegido contra cambios directos.
- Un doble clic envía una solicitud. A los 20 segundos se libera la espera y se
  ofrece **Verificar eliminación** con la misma identidad. Mientras falta
  confirmación, la captura se bloquea y el navegador advierte antes de recargar.
  Esta verificación pendiente se conserva en memoria de la pestaña.

## Instalación y revisión paso a paso

1. Abrir **el proyecto Free de pruebas** de Supabase y comprobar su nombre en la
   cabecera. Abrir **SQL Editor → New query**. Copiar completo
   [20261113_delete_archived_document.sql](supabase/migrations/20261113_delete_archived_document.sql)
   y ejecutarlo sin seleccionar un fragmento. Instalarlo no elimina documentos.
   No ejecutar todo `schema.sql` ni el generador de datos sobre una base existente.
2. Ejecutar completo [revision-eliminacion.sql](scripts/revision-eliminacion.sql).
   Deben aparecer `true` en `eliminacion_disponible`, `historial_protegido` y
   `confirmaciones_privadas`. La consulta es de solo lectura.
3. Abrir el [Preview de pruebas](https://rastreodoc-git-codex-rastreadoc-pruebas-jasg.vercel.app/)
   y recargar. Usar un documento ficticio creado para esta prueba. Archivar ese
   documento desde Buscar y abrir Archivados.
4. Comprobar que la confirmación identifica el documento correcto. Probar Cancelar,
   volver a abrir y escribir `ELIMINAR`. Verificar que desaparece de Archivados,
   que el expediente permanece y que otro documento conserva su historial.
5. Publicar en producción solamente después de revisar el resultado y recibir la
   aprobación del usuario. Instalar la misma migración en el proyecto real,
   comprobar los tres resultados y desplegar desde `main` para usar sus variables
   de producción. Nunca promover el artefacto de Preview con la base Free.

La eliminación afecta los registros de la base, no borra archivos del servidor
de oficina ni objetos de Supabase Storage. Los respaldos previos pueden conservar
los registros durante su retención; el espacio físico de Postgres no tiene por
qué disminuir inmediatamente. No se cambió la configuración de respaldos.

## Archivos y validación

- `supabase/migrations/20261113_delete_archived_document.sql`: función atómica,
  constancia privada y excepción limitada del historial durante esa transacción.
- `supabase/schema.sql`: la misma definición para instalaciones nuevas, sin
  límites de transacción que interfieran con el generador de pruebas existente.
- `lib/document-deletion.mjs`: confirmación, reintentos y límite de espera.
- `app/components/document-deletion-dialog.js`, `app/components/ui.js`,
  `app/home-page.js`, `app/redesign.css`: diálogo accesible, botón y apariencia.
- `scripts/revision-eliminacion.sql`: comprobación posterior de solo lectura.
- `tests/document-deletion.test.mjs`, `tests/document-operations-db.py`,
  `tests/document-operations-browser.py`: desconexiones, concurrencia, reversión
  completa ante fallos, alcance del borrado, roles, confirmación y móvil.

Las pruebas usan datos ficticios y PostgreSQL local desechable. No se han
eliminado documentos reales ni aplicado migraciones a Supabase desde este entorno.

Validación de esta entrega: 74 pruebas de JavaScript, 44 de PostgreSQL y 51 de
navegador correctas (169 en total). Se repitieron las 6 de eliminación después
de ajustar el foco del diálogo para teclado. La compilación pasó; lint no tiene
errores y conserva la advertencia anterior del `<img>` usado para el QR.
Los recorridos existentes de alta, movimientos, reportes, QR y las nueve vistas
continuaron pasando. Los teléfonos se verificaron por emulación de Chromium.

## Revisión manual confirmada por el usuario

El 13 de noviembre de 2026 el usuario confirmó la instalación en Supabase de
pruebas y los tres resultados `true` de la consulta de revisión. Mostró el diálogo
en Preview para **AVISO PREVENTIVO — BORRAR-PRUEBA**, del expediente ficticio
**PRUEBA-ELIMINAR.** (con punto final en la captura).

Se aclaró que el botón requiere escribir exactamente `ELIMINAR`; no se cambió
esa confirmación. El usuario confirmó después el mensaje de eliminación y la
desaparición del documento de Archivados. Tras la instrucción de recargar,
confirmó que el expediente seguía disponible y que otro documento conservaba
su historial. La aplicación se revisó con datos ficticios del proyecto de pruebas.

El usuario autorizó expresamente instalar esta mejora en el sistema real y
publicarla. Después confirmó los tres resultados `true` al ejecutar en el
proyecto real `vmmafjnhtluinmmjyigv` el archivo con la misma migración y la
consulta de revisión. La instalación en Supabase fue realizada por el usuario.

La publicación autorizada se realiza desde `main`, con el mismo código funcional
probado en `63b4a9a`; los cambios posteriores son documentación. La comprobación
pública posterior debe verificar la nueva interfaz, los scripts servidos y que
el backend siga siendo `vmmafjnhtluinmmjyigv.supabase.co`. No se promueve el
artefacto de Preview ni se eliminan documentos reales para comprobar el despliegue.
