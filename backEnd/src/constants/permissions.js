// Catálogo único de permisos del sistema. Cada id debe coincidir EXACTO con
// el usado en el frontend (src/constants/permissions.js) y con lo que se
// guarda en employeeModel.permissions (array de strings).
//
// Dos tipos de permiso:
//   - "screen": acceso a una pantalla completa (coincide 1 a 1 con los items
//     del Sidebar, más "notifications"/"settings" que hoy no están en el
//     Sidebar pero sí son rutas protegidas).
//   - "action": una función puntual y sensible dentro de una pantalla, para
//     poder ser más específico que "toda la pantalla o nada".
export const PERMISSIONS = [
  // --- Pantallas (Principal) ---
  { id: "dashboard", label: "Actividad y Análisis", group: "Pantallas", type: "screen" },

  // --- Pantallas (Menú) ---
  { id: "combos", label: "Combos", group: "Pantallas", type: "screen" },
  { id: "drinks", label: "Bebidas", group: "Pantallas", type: "screen" },
  { id: "dishes", label: "Platillos", group: "Pantallas", type: "screen" },
  { id: "extras", label: "Extras", group: "Pantallas", type: "screen" },
  { id: "recipes", label: "Recetas", group: "Pantallas", type: "screen" },

  // --- Pantallas (Operaciones) ---
  { id: "orders", label: "Pedidos y Órdenes", group: "Pantallas", type: "screen" },
  { id: "tables", label: "Mesas", group: "Pantallas", type: "screen" },
  { id: "inventory", label: "Inventario", group: "Pantallas", type: "screen" },

  // --- Pantallas (Administración) ---
  { id: "clients", label: "Clientes", group: "Pantallas", type: "screen" },
  { id: "employees", label: "Empleados", group: "Pantallas", type: "screen" },
  { id: "invite_staff", label: "Invitar staff", group: "Pantallas", type: "screen" },
  { id: "payroll", label: "Planilla", group: "Pantallas", type: "screen" },
  { id: "reports", label: "Reportes contables (IVA)", group: "Pantallas", type: "screen" },

  // --- Pantallas (Otras) ---
  { id: "notifications", label: "Notificaciones", group: "Pantallas", type: "screen" },
  { id: "settings", label: "Ajustes", group: "Pantallas", type: "screen" },

  // --- Funciones específicas ---
  { id: "orders_cancel", label: "Cancelar pedidos", group: "Funciones", type: "action" },
  { id: "employees_manage_status", label: "Dar de alta/baja empleados", group: "Funciones", type: "action" },
  { id: "clients_manage_status", label: "Activar/desactivar clientes", group: "Funciones", type: "action" },
  { id: "inventory_adjust_stock", label: "Ajustar existencias de inventario", group: "Funciones", type: "action" },
  { id: "tables_change_status", label: "Cambiar el estado de una mesa", group: "Funciones", type: "action" },
];

export const PERMISSION_IDS = PERMISSIONS.map((p) => p.id);

export const isValidPermission = (id) => PERMISSION_IDS.includes(id);

export default { PERMISSIONS, PERMISSION_IDS, isValidPermission };
