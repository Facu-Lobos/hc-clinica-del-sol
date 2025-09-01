/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import jsPDF from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import 'jspdf-autotable';
declare module 'jspdf' {
    interface jsPDF {
        autoTable: (options: any) => jsPDF;
        lastAutoTable: { finalY: number };
    }
}
// --- Supabase Setup ---
const SUPABASE_URL = "https://obykeczhieefcpeixgiv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ieWtlY3poaWVlZmNwZWl4Z2l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTkwNjEwMzYsImV4cCI6MTczNDcxMzAzNn0.77R8x9mO2xP1JdO4gq69vL_zY95gXwY6V0xX_z0D0w";

// --- User Profile Type Definition ---
interface UserProfile {
    id: string; // UUID from auth.users
    nombre: string;
    apellido: string;
    especialidad: string;
    matricula?: string;
    firma?: string; // Base64 encoded image
    username: string;
}

// --- START: Supabase API Layer ---
let supabase: SupabaseClient;

/**
 * Logs in a user and fetches their profile.
 * @param username The user's username.
 * @param password The user's password.
 * @returns The user's profile data.
 */
const apiLogin = async (username: string, password: string): Promise<UserProfile> => {
    // Supabase auth uses email, so we construct one. Assumes usernames are unique.
    const email = `${username.trim()}@clinica.local`;
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) throw authError;
    if (!authData.user) throw new Error("Login failed, no user returned.");

    const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', authData.user.id)
        .single();

    if (profileError) {
        // Log out the user if their profile is missing to prevent a broken state
        await supabase.auth.signOut();
        throw profileError;
    }
    if (!profileData) throw new Error("Login failed, user profile not found.");

    return profileData as UserProfile;
};

/**
 * Logs out the current user.
 */
const apiLogout = async (): Promise<void> => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
};

/**
 * Fetches a single patient record by DNI.
 * @param dni The patient's DNI.
 * @returns The patient's data object or null if not found.
 */
const apiGetPatientByDni = async (dni: string): Promise<any | null> => {
    const { data, error } = await supabase
        .from('patient_records')
        .select('data')
        .eq('dni', dni)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // PostgREST error for "exact one row not found" is expected
        console.error("Error fetching patient:", error);
        throw error;
    }
    return data ? data.data : null;
};

/**
 * Creates or updates a patient record.
 * @param dni The patient's DNI.
 * @param patientData The complete data object for the patient.
 */
const apiSavePatient = async (dni: string, patientData: any): Promise<void> => {
    const { error } = await supabase
        .from('patient_records')
        .upsert({ dni: dni, data: patientData }, { onConflict: 'dni' });
    
    if (error) {
        console.error("Error saving patient:", error);
        throw error;
    }
};

/**
 * Fetches all user profiles. Should only be called by an admin.
 * @returns An array of user profiles.
 */
const apiGetAllUsers = async (): Promise<UserProfile[]> => {
    const { data, error } = await supabase
        .from('profiles')
        .select('*');

    if (error) {
        console.error("Error fetching users:", error);
        throw error;
    }
    return data as UserProfile[];
}

/**
 * Creates a new user by invoking a Supabase Edge Function.
 * @param userData The data for the new user.
 */
const apiCreateUser = async (userData: { username: string, password: string, profileData: Omit<UserProfile, 'id'> }) => {
    const { data, error } = await supabase.functions.invoke('create-user', {
        body: userData,
    });

    if (error) throw error;
    return data;
}

// --- END: Supabase API Layer ---


document.addEventListener('DOMContentLoaded', () => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        document.body.innerHTML = `<div style="padding: 2rem; text-align: center; font-family: sans-serif; color: red;">
            <h1>Error de Configuración</h1>
            <p>Las variables de entorno de Supabase (SUPABASE_URL, SUPABASE_ANON_KEY) no están configuradas.</p>
        </div>`;
        return;
    }
    
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    
    let currentUser: UserProfile | null = null;

    // --- UI Element References ---
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginView = document.getElementById('login-view');
    const userSessionDisplay = document.getElementById('user-session');
    const userInfoDisplay = document.getElementById('user-info');
    const lockBanner = document.getElementById('lock-banner');
    const adminTab = document.getElementById('admin-tab');

    // --- Role-Based Access Control ---
    const applyRoleBasedAccess = (user: UserProfile | null) => {
        if (!user) return;

        // Admin sees all
        if (user.especialidad === 'Administrador') {
            const allInputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('#app-container form input, #app-container form textarea, #app-container form select, #app-container form button');
            allInputs.forEach(el => { el.disabled = false; });
            return;
        }

        const allInputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('#app-container form input, #app-container form textarea, #app-container form select, #app-container form button');
        allInputs.forEach(el => {
            el.disabled = true;
        });

        const rolePermissions: { [key: string]: string[] } = {
            'Administrativo': ['administrativo'],
            'Enfermero': ['enfermero'],
            'Anestesista': ['anestesista'],
            'Médico': ['medico']
        };

        const userRoles = rolePermissions[user.especialidad] || [];

        userRoles.forEach(role => {
            const sections = document.querySelectorAll(`[data-role="${role}"]`);
            sections.forEach(section => {
                const inputs = section.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input, textarea, select, button');
                inputs.forEach(input => {
                    input.disabled = false;
                });
            });
        });
    };
    
    // --- Form Locking Logic ---
    const unlockForm = () => {
        if (lockBanner) lockBanner.style.display = 'none';

        const saveBtn = document.getElementById('save-progress-btn') as HTMLButtonElement;
        const generateBtn = document.getElementById('generate-alta-btn') as HTMLButtonElement;
        const importBtn = document.getElementById('import-clinic-btn') as HTMLButtonElement;
        const exportBtn = document.getElementById('export-clinic-btn') as HTMLButtonElement;
        
        if(saveBtn) saveBtn.disabled = false;
        if(generateBtn) generateBtn.disabled = false;
        if(importBtn) importBtn.disabled = false;
        if(exportBtn) exportBtn.disabled = false;

        applyRoleBasedAccess(getCurrentUser());
    };

    const lockForm = (timestamp: number) => {
        if (lockBanner) {
            const lockDate = new Date(timestamp).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
            lockBanner.innerHTML = `Este registro fue cerrado el ${lockDate} y ya no puede ser modificado.`;
            lockBanner.style.display = 'block';
        }

        const allForms = document.querySelectorAll<HTMLFormElement>('#app-container form');
        allForms.forEach(form => {
            const elements = form.querySelectorAll('input, textarea, select, button');
            elements.forEach(el => (el as HTMLInputElement).disabled = true);
        });

        const saveBtn = document.getElementById('save-progress-btn') as HTMLButtonElement;
        const generateBtn = document.getElementById('generate-alta-btn') as HTMLButtonElement;
        const importBtn = document.getElementById('import-clinic-btn') as HTMLButtonElement;
        const exportBtn = document.getElementById('export-clinic-btn') as HTMLButtonElement;

        if (saveBtn) saveBtn.disabled = true;
        if (generateBtn) generateBtn.disabled = true;
        if (importBtn) importBtn.disabled = true;
        if (exportBtn) exportBtn.disabled = true;
    };


    // --- View Toggling Functions ---
    const showLoginView = () => {
        if (loginView) loginView.style.display = 'block';
        if (authContainer) authContainer.style.display = 'flex';
        if (appContainer) appContainer.style.display = 'none';
        if (userSessionDisplay) userSessionDisplay.style.display = 'none';
    };

    const showAppView = (user: UserProfile) => {
        if (authContainer) authContainer.style.display = 'none';
        if (appContainer) appContainer.style.display = 'block';
        if (userSessionDisplay) userSessionDisplay.style.display = 'flex';
        if (userInfoDisplay) userInfoDisplay.textContent = `Bienvenido(a), ${user.nombre} ${user.apellido} (${user.especialidad})`;
        
        // Show/hide admin tab based on role
        if (adminTab) {
            adminTab.style.display = user.especialidad === 'Administrador' ? 'block' : 'none';
        }

        unlockForm();
        applyRoleBasedAccess(user);
    };

    // --- Authentication Logic ---
    const getCurrentUser = (): UserProfile | null => {
        return currentUser;
    }

    const updateUserSession = (profile: UserProfile | null) => {
        currentUser = profile;
        if (profile) {
            showAppView(profile);
        } else {
            showLoginView();
        }
    };
    
    // --- Event Listeners for Auth ---
    document.getElementById('login-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target as HTMLFormElement;
        const submitButton = form.querySelector('button[type="submit"]') as HTMLButtonElement;
        submitButton.disabled = true;
        submitButton.textContent = 'Ingresando...';

        const username = (document.getElementById('login-username') as HTMLInputElement).value;
        const password = (document.getElementById('login-password') as HTMLInputElement).value;
        const loginError = document.getElementById('login-error') as HTMLParagraphElement;
        loginError.style.display = 'none';
        
        try {
            await apiLogin(username, password);
            // onAuthStateChange will handle showing the app view
        } catch (error: any) {
            console.error('Login failed:', error);
            loginError.textContent = 'Usuario o contraseña incorrectos.';
            loginError.style.display = 'block';
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = 'Ingresar';
        }
    });
    
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
        try {
            await apiLogout();
             // Clear form fields on logout to prevent data leakage
            const forms = document.querySelectorAll<HTMLFormElement>('#app-container form');
            forms.forEach(form => {
                form.reset();
                // Also clear signature displays
                form.querySelectorAll('.signature-display').forEach(display => {
                    display.innerHTML = '';
                });
            });
            unlockForm();
            // onAuthStateChange will handle showing the login view
        } catch (error) {
            console.error("Logout failed:", error);
            alert("Error al cerrar sesión.");
        }
    });

    // --- Initial Check & Session Management ---
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (session?.user) {
            try {
                const { data: profile, error } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('id', session.user.id)
                    .single();
                
                if (error) throw error;

                updateUserSession(profile as UserProfile);
            } catch (error) {
                console.error("Failed to fetch user profile on auth change", error);
                // Force sign out if profile is missing
                await apiLogout();
                updateUserSession(null);
            }
        } else {
            updateUserSession(null);
        }
    });
    
    // --- Helper function to convert file to Base64 ---
    const fileToBase64 = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = error => reject(error);
        });
    };

    // --- Admin Panel Logic ---
    const populateUsersTable = async () => {
        const tableBody = document.getElementById('users-table-body');
        if (!tableBody) return;

        try {
            const users = await apiGetAllUsers();
            tableBody.innerHTML = ''; // Clear existing rows
            users.forEach(user => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${user.nombre} ${user.apellido}</td>
                    <td>${user.username}</td>
                    <td>${user.especialidad}</td>
                `;
                tableBody.appendChild(row);
            });
        } catch (error) {
            console.error("Could not populate users table", error);
            tableBody.innerHTML = `<tr><td colspan="3">Error al cargar usuarios.</td></tr>`;
        }
    };

    document.getElementById('create-user-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target as HTMLFormElement;
        const submitButton = form.querySelector('button[type="submit"]') as HTMLButtonElement;
        const errorEl = document.getElementById('create-user-error') as HTMLParagraphElement;
        const successEl = document.getElementById('create-user-success') as HTMLParagraphElement;

        errorEl.style.display = 'none';
        successEl.style.display = 'none';
        submitButton.disabled = true;
        submitButton.textContent = 'Creando...';
        
        try {
            const username = (document.getElementById('create-username') as HTMLInputElement).value;
            const password = (document.getElementById('create-password') as HTMLInputElement).value;
            const nombre = (document.getElementById('create-nombre') as HTMLInputElement).value;
            const apellido = (document.getElementById('create-apellido') as HTMLInputElement).value;
            const especialidad = (document.getElementById('create-especialidad') as HTMLSelectElement).value;
            const matricula = (document.getElementById('create-matricula') as HTMLInputElement).value;
            const firmaInput = (document.getElementById('create-firma') as HTMLInputElement);

            let firmaBase64: string | undefined = undefined;
            if (firmaInput.files && firmaInput.files[0]) {
                firmaBase64 = await fileToBase64(firmaInput.files[0]);
            }

            const profileData = {
                username,
                nombre,
                apellido,
                especialidad,
                matricula: matricula || undefined,
                firma: firmaBase64
            };

            await apiCreateUser({ username, password, profileData });

            successEl.textContent = `Usuario "${username}" creado exitosamente.`;
            successEl.style.display = 'block';
            form.reset();
            await populateUsersTable();

        } catch (error: any) {
            console.error("User creation failed:", error);
            errorEl.textContent = `Error al crear usuario: ${error.message}`;
            errorEl.style.display = 'block';
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = 'Crear Usuario';
        }
    });

    document.getElementById('create-especialidad')?.addEventListener('change', (e) => {
        const select = e.target as HTMLSelectElement;
        const matriculaGroup = document.getElementById('create-matricula-group');
        if (matriculaGroup) {
            const medicalRoles = ['Médico', 'Enfermero', 'Anestesista'];
            matriculaGroup.style.display = medicalRoles.includes(select.value) ? 'block' : 'none';
        }
    });


    // --- Tabbed Interface Logic ---
    const tabs = document.querySelectorAll('.tab-link');
    const tabContents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', async () => {
            const targetId = tab.getAttribute('data-tab');
            
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === targetId) {
                    content.classList.add('active');
                }
            });
            const user = getCurrentUser();
            if(user) applyRoleBasedAccess(user);

            // If admin tab is clicked, load users
            if (targetId === 'admin-usuarios') {
                await populateUsersTable();
            }
        });
    });
    
    // --- Centralized Patient Data Loading Logic ---
    const populateForm = (form: HTMLFormElement, formData: any) => {
        const prefix = form.id.replace('form', ''); // e.g., 'hd-', 'ge-'

        Object.keys(formData).forEach(key => {
            const element = document.getElementById(`${prefix}${key}`) as HTMLInputElement;
            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = formData[key];
                } else {
                    element.value = formData[key];
                }
            }
        });

        const tables = form.querySelectorAll('table[data-table-name]');
        tables.forEach(table => {
            const tableName = (table as HTMLElement).dataset.tableName;
            const tableData = tableName ? formData[tableName] : null;
            const tableBody = table.querySelector('tbody');

            if (tableData && tableBody) {
                tableBody.innerHTML = ''; // Clear existing rows
                const addRowButtonClass = table.closest('.form-section')?.querySelector('button[class*="add-"]')?.classList.toString().match(/add-[\w-]+-row/)?.[0];

                (tableData as any[]).forEach(rowData => {
                    if (addRowButtonClass) {
                        const addButton = document.createElement('button');
                        addButton.style.display = 'none';
                        addButton.classList.add(addRowButtonClass);
                        form.appendChild(addButton);
                        addButton.click();
                        addButton.remove();
                       
                        const newRow = tableBody.querySelector('tr:last-child');
                        if (newRow) {
                            Object.keys(rowData).forEach(inputName => {
                                const input = newRow.querySelector(`[name="${inputName}"]`) as HTMLInputElement;
                                if (input) input.value = rowData[inputName];
                            });
                        }
                    }
                });
            }
        });
    };
    
    const loadPatientDataIntoForms = (patientData: any) => {
        unlockForm();
        const allForms = document.querySelectorAll<HTMLFormElement>('#app-container form');
        allForms.forEach(form => form.reset());

        Object.keys(patientData).forEach(tabId => {
            if (tabId === 'dischargeTimestamp') return;

            const form = document.querySelector(`#${tabId} form`) as HTMLFormElement;
            const dataForTab = patientData[tabId];

            if (form && dataForTab) {
                populateForm(form, dataForTab);
            }
        });

        const firstFormPrefix = document.querySelector<HTMLFormElement>('#app-container form')?.id.replace('form', '');
        if (firstFormPrefix) {
            const apellidoEl = document.getElementById(`${firstFormPrefix}apellido`);
            const nombresEl = document.getElementById(`${firstFormPrefix}nombres`);
            apellidoEl?.dispatchEvent(new Event('input', { bubbles: true }));
            nombresEl?.dispatchEvent(new Event('input', { bubbles: true }));
        }

        if (patientData.dischargeTimestamp) {
            const twentyFourHours = 24 * 60 * 60 * 1000;
            if (Date.now() - patientData.dischargeTimestamp > twentyFourHours) {
                lockForm(patientData.dischargeTimestamp);
            }
        }
    };


    // --- Dynamic Table & Signature Logic (Event Delegation) ---
    document.body.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;

        if (target.classList.contains('sign-section-btn')) {
            const user = getCurrentUser();
            if (!user || !user.firma) {
                alert('No se encontró una firma registrada. Por favor, asegúrese de haber subido una firma en su perfil.');
                return;
            }

            const targetId = target.getAttribute('data-target-id');
            if (!targetId) return;

            const signatureDisplay = document.getElementById(targetId);
            if (signatureDisplay) {
                signatureDisplay.innerHTML = '';
                const signatureImg = document.createElement('img');
                signatureImg.src = user.firma;
                signatureImg.alt = `Firma de ${user.nombre} ${user.apellido}`;
                signatureDisplay.appendChild(signatureImg);
            }
        }

        if (target.classList.contains('add-practica-row')) {
            const section = target.closest('.form-section');
            const tableBody = section?.querySelector('.practicas-medicas-table tbody');
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><input type="date" name="Practica Fecha" required></td>
                <td><input type="text" name="Practica Código" required></td>
                <td><input type="text" name="Practica Descripción" required></td>
                <td><input type="number" name="Practica Cantidad" required></td>
                <td><input type="text" name="Practica Observación" required></td>
                <td><button type="button" class="delete-row-btn">&times;</button></td>
            `;
            tableBody?.appendChild(row);
        }

        if (target.classList.contains('add-enfermeria-row')) {
            const section = target.closest('.form-section');
            const tableBody = section?.querySelector('.enfermeria-table tbody');
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><input type="date" name="Enfermeria Fecha" required></td>
                <td><input type="time" name="Enfermeria Hora" required></td>
                <td><input type="text" name="Enfermeria TA" required></td>
                <td><input type="text" name="Enfermeria FC" required></td>
                <td><input type="text" name="Enfermeria FR" required></td>
                <td><input type="text" name="Enfermeria Temp" required></td>
                <td><input type="text" name="Enfermeria Observaciones" required></td>
                <td><button type="button" class="delete-row-btn">&times;</button></td>
            `;
            tableBody?.appendChild(row);
        }
        
        if (target.classList.contains('add-monitoreo-row')) {
            const section = target.closest('.form-section');
            const tableBody = section?.querySelector('.monitoreo-table tbody');
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><input type="time" name="Monitoreo Hora" required></td>
                <td><input type="number" name="Monitoreo Sistolica" required></td>
                <td><input type="number" name="Monitoreo Diastolica" required></td>
                <td><input type="number" name="Monitoreo Pulso" required></td>
                <td><button type="button" class="delete-row-btn">&times;</button></td>
            `;
            tableBody?.appendChild(row);
        }

        if (target.classList.contains('add-prescripcion-row')) {
            const section = target.closest('.form-section');
            const tableBody = section?.querySelector('.prescripciones-table tbody');
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><input type="date" name="Prescripcion Fecha" required></td>
                <td><input type="text" name="Prescripcion Indicaciones" required></td>
                <td><button type="button" class="delete-row-btn">&times;</button></td>
            `;
            tableBody?.appendChild(row);
        }

        if (target.classList.contains('delete-row-btn')) {
            target.closest('tr')?.remove();
        }

        if (target.classList.contains('load-patient-btn')) {
            const loadButton = target as HTMLButtonElement;
            loadButton.disabled = true;
            loadButton.textContent = 'Cargando...';

            const dniInput = target.previousElementSibling as HTMLInputElement;
            if (!dniInput) return;

            const dni = dniInput.value.trim();
            if (!dni) {
                alert('Por favor, ingrese un DNI para buscar.');
                loadButton.disabled = false;
                loadButton.textContent = 'Cargar';
                return;
            }

            try {
                const patientData = await apiGetPatientByDni(dni);

                if (!patientData) {
                    alert('No se encontraron datos para este DNI. Puede crear un nuevo registro.');
                    const forms = document.querySelectorAll<HTMLFormElement>('#app-container form');
                    forms.forEach(form => form.reset());
                    unlockForm();
                    // Set the DNI in the active form for a new patient
                    dniInput.value = dni;
                    return;
                }
                
                loadPatientDataIntoForms(patientData);
                alert('Datos del paciente cargados en todas las secciones.');
            } catch (error) {
                alert('Error al cargar los datos del paciente.');
                console.error("Failed to load patient:", error);
            } finally {
                loadButton.disabled = false;
                loadButton.textContent = 'Cargar';
            }
        }
    });

    // --- Patient Name Auto-Population Logic ---
    const syncPatientNames = (prefix: string) => {
        const apellidoEl = document.getElementById(`${prefix}-apellido`) as HTMLInputElement;
        const nombresEl = document.getElementById(`${prefix}-nombres`) as HTMLInputElement;

        if (!apellidoEl || !nombresEl) return;

        const updateDerivedPatientFields = () => {
            const apellido = apellidoEl.value.trim();
            const nombres = nombresEl.value.trim();
            const fullName = [apellido, nombres].filter(Boolean).join(', ');

            const targetIds = [
                'paciente-2', 'paciente-4', 'paciente-5', 'paciente-6',
                'paciente-evolucion', 'paciente-report',
                'paciente-presc', 'paciente-practicas', 'paciente-enfermeria',
                'paciente-anest'
            ];

            targetIds.forEach(idSuffix => {
                const targetEl = document.getElementById(`${prefix}-${idSuffix}`) as HTMLInputElement;
                if (targetEl) {
                    targetEl.value = fullName;
                }
            });
        };

        apellidoEl.addEventListener('input', updateDerivedPatientFields);
        nombresEl.addEventListener('input', updateDerivedPatientFields);
    };

    ['hd', 'ge', 'cg', 'ca'].forEach(syncPatientNames);
    
    // --- Save Patient Progress ---
    document.getElementById('save-progress-btn')?.addEventListener('click', async () => {
        const saveButton = document.getElementById('save-progress-btn') as HTMLButtonElement;
        saveButton.disabled = true;
        saveButton.textContent = 'Guardando...';

        const activeContent = document.querySelector('.tab-content.active');
        if (!activeContent) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar Progreso';
            return;
        }
        
        const form = activeContent.querySelector('form');
        if (!form) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar Progreso';
            return;
        }
        
        const activeTabId = activeContent.id;
        const prefix = form.id.replace('form', '');
        const dniInput = document.getElementById(`${prefix}dni`) as HTMLInputElement;
        const dni = dniInput?.value.trim();

        if (!dni) {
            alert('Por favor, complete el DNI del paciente para poder guardar.');
            dniInput?.focus();
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar Progreso';
            return;
        }

        const formData: { [key: string]: any } = {};
        
        const elements = form.elements;
        for (let i = 0; i < elements.length; i++) {
            const item = elements[i] as HTMLInputElement;
            if (item.id && item.id.startsWith(prefix)) {
                const key = item.id.substring(prefix.length);
                if(item.type === 'checkbox'){
                    formData[key] = item.checked;
                } else {
                    formData[key] = item.value;
                }
            }
        }
        
        form.querySelectorAll('table[data-table-name]').forEach(table => {
            const tableName = (table as HTMLElement).dataset.tableName;
            if(!tableName) return;

            const tableData: any[] = [];
            table.querySelectorAll('tbody tr').forEach(row => {
                const rowData: { [key: string]: any } = {};
                row.querySelectorAll('input, select, textarea').forEach(input => {
                    const el = input as HTMLInputElement;
                    if (el.name) {
                        rowData[el.name] = el.value;
                    }
                });
                tableData.push(rowData);
            });
            formData[tableName] = tableData;
        });

        try {
            const patientData = await apiGetPatientByDni(dni) || {};
            patientData[activeTabId] = formData;
            
            await apiSavePatient(dni, patientData);
            alert('¡Progreso guardado exitosamente!');
        } catch (error) {
            alert('Error al guardar el progreso.');
            console.error('Failed to save progress:', error);
        } finally {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar Progreso';
        }
    });
    
    // --- Import / Export Logic ---
    const fileInput = document.getElementById('import-clinic-input') as HTMLInputElement;

    document.getElementById('import-clinic-btn')?.addEventListener('click', () => {
        fileInput?.click();
    });

    document.getElementById('export-clinic-btn')?.addEventListener('click', async () => {
        const dniInput = document.querySelector('input[id$="-dni"]:not([value=""])') as HTMLInputElement;
        const dni = dniInput?.value.trim();

        if (!dni) {
            alert('No hay un paciente cargado. Por favor, cargue un paciente por DNI antes de exportar.');
            return;
        }
        try {
            const patientData = await apiGetPatientByDni(dni);

            if (!patientData) {
                alert('No se encontraron datos para exportar para el DNI actual.');
                return;
            }

            const dataStr = JSON.stringify(patientData, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            
            const link = document.createElement('a');
            link.href = url;
            link.download = `paciente-${dni}.clinic`;
            document.body.appendChild(link);
            link.click();
            
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch(error) {
            alert('Error al exportar los datos.');
            console.error('Export failed', error);
        }
    });
    
    fileInput?.addEventListener('change', (event) => {
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0];

        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const text = e.target?.result as string;
                const importedData = JSON.parse(text);
                
                let dni = '';
                const mainTabs = ['hemodinamia', 'grupo-endoscopico', 'cirugias', 'cirugia-anestesia'];
                for (const tab of mainTabs) {
                    if (importedData[tab]?.dni) {
                        dni = importedData[tab].dni;
                        break;
                    }
                }
                
                if (!dni) {
                    throw new Error('No se pudo encontrar un DNI en el archivo importado.');
                }

                await apiSavePatient(dni, importedData);
                loadPatientDataIntoForms(importedData);
                
                alert(`Datos del paciente con DNI ${dni} importados y cargados exitosamente.`);

            } catch (error: any) {
                console.error('Error al importar archivo:', error);
                alert(`Hubo un error al procesar el archivo .clinic. Asegúrese de que el formato sea correcto. Detalles: ${error.message}`);
            } finally {
                target.value = '';
            }
        };

        reader.onerror = () => {
            alert('Error al leer el archivo.');
            target.value = '';
        };

        reader.readAsText(file);
    });

    // --- PDF Generation Logic ---
    const generateAltaBtn = document.getElementById('generate-alta-btn');
    
    const setDischargeTimestamp = async () => {
        const activeContent = document.querySelector('.tab-content.active');
        const dniInput = activeContent?.querySelector('input[id$="-dni"]') as HTMLInputElement;
        if (dniInput) {
            const dni = dniInput.value.trim();
            if (!dni) return;

            try {
                const patientData = await apiGetPatientByDni(dni) || {};
                
                if (!patientData.dischargeTimestamp) {
                    patientData.dischargeTimestamp = Date.now();
                    await apiSavePatient(dni, patientData);
                }
            } catch (error) {
                console.error('Failed to set discharge timestamp', error);
                alert('Error al registrar la fecha de alta.');
            }
        }
    };
    
    const margin = 15;
    const fieldMargin = 45;
    const lineSpacing = 8;
    const pageWidth = 210;
    const pageHeight = 297;
    const logoY = 20;
    const logoRadius = 7;
    
    const drawHeader = (pdf: jsPDF) => {
        pdf.setFontSize(16);
        const titleText = 'CLINICA DEL SOL';
        const titleWidth = pdf.getTextWidth(titleText);
        const logoWidth = logoRadius*2 ;
        const gap = 8;
        const totalWidth = logoWidth + gap + titleWidth;
        const startX = (pageWidth - totalWidth) / 2;
        const logoX = startX + logoRadius;
        const textX = startX + logoWidth + gap;
        pdf.setFillColor(56, 186, 234);
        pdf.circle(logoX, logoY, logoRadius, 'F');
        pdf.setDrawColor(255, 255, 255);
        pdf.setLineWidth(1.5);
        const crossSize = logoRadius * 0.5;
        pdf.line(logoX, logoY - crossSize, logoX, logoY + crossSize);
        pdf.line(logoX + crossSize, logoY, logoX + crossSize, logoY);
        pdf.setFontSize(16);
        pdf.setTextColor(0, 174, 239);
        pdf.text(titleText, textX, logoY, { baseline: 'middle' });
        pdf.setFontSize(10);
        pdf.setTextColor(101, 119, 134);
        pdf.text('CLINICA PRIVADA', textX, logoY + 7);
        const headerBottomY = logoY + logoRadius + 8;
        pdf.setDrawColor(225, 232, 237);
        pdf.setLineWidth(0.5);
        pdf.line(margin, headerBottomY, pageWidth - margin, headerBottomY);
        pdf.setDrawColor(0,0,0);
        pdf.setTextColor(0,0,0);
        pdf.setLineWidth(0.2);
    };

    const drawField = (pdf: jsPDF, label: string, value: string, yPos: number, xStart: number = margin, xValStart?: number) => {
        pdf.text(label, xStart, yPos);
        pdf.text(value, xValStart || (xStart + fieldMargin), yPos);
    };
    
    const drawTextArea = (pdf: jsPDF, label: string, textContent: string, startY: number, numLines: number) => {
        pdf.text(label, margin, startY);
        pdf.setLineDashPattern([1, 1], 0);
        let lineY = startY + 4;
        const lineHeight = 5;
        const lines = pdf.splitTextToSize(textContent, pageWidth - margin * 2);
        
        for (let i = 0; i < numLines; i++) {
            const middleY = lineY + lineHeight / 2;
            if (i < lines.length) {
                pdf.text(lines[i], margin, middleY, { baseline: 'middle' });
            }
            pdf.line(margin, lineY, pageWidth - margin, lineY);
            lineY += lineHeight;
        }
        pdf.setLineDashPattern([], 0);
        return lineY + 4;
    };
    
    const drawUserSignature = (pdf: jsPDF, user: UserProfile) => {
        const signatureY = pageHeight - 25;
        const signatureXStart = pageWidth - margin - 70;
        pdf.setDrawColor(150);
        pdf.line(signatureXStart, signatureY, pageWidth - margin, signatureY);
        if (user.firma) {
            try {
                const signatureWidth = 35;
                const signatureHeight = 12;
                pdf.addImage(user.firma, 'PNG', signatureXStart + 5, signatureY - signatureHeight, signatureWidth, signatureHeight);
            } catch (e) {
                console.error("Could not add signature image to PDF", e);
            }
        }
        pdf.setFontSize(8).setTextColor(100);
        const signatureText = `${user.nombre} ${user.apellido}`;
        const specialtyText = `(${user.especialidad})`;
        pdf.text(signatureText, signatureXStart, signatureY + 4);
        pdf.text(specialtyText, signatureXStart, signatureY + 8);
        pdf.setFontSize(10).setTextColor(0,0,0);
        pdf.setDrawColor(0);
    };
    
    const generateAndRenderPage = (
        pdf: jsPDF,
        patientData: any,
        title: string,
        fields: { label: string, key: string }[],
        textAreas: { label: string, key: string, lines: number }[],
        tableData?: { tableName: string, key: string, columns: string[], rowsMap: (row: any) => any[] }[],
    ) => {
        pdf.addPage();
        drawHeader(pdf);
        let y = 45;
        pdf.setFontSize(14).text(title, pageWidth / 2, y, { align: 'center' });
        y += lineSpacing * 3;
        pdf.setFontSize(10).setTextColor(0,0,0);

        fields.forEach(field => {
            drawField(pdf, field.label, patientData[field.key] || '', y);
            y += lineSpacing;
        });

        if (fields.length > 0) y += lineSpacing;

        textAreas.forEach(area => {
            const textContent = patientData[area.key] || '';
            y = drawTextArea(pdf, area.label, textContent, y, area.lines);
        });

        if (tableData) {
            tableData.forEach(table => {
                pdf.setFontSize(10).text(table.tableName, margin, y);
                y += lineSpacing;
                (pdf as any).autoTable({
                    startY: y,
                    head: [table.columns],
                    body: (patientData[table.key] || []).map(table.rowsMap),
                    theme: 'grid',
                    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
                    headStyles: { fillColor: [200, 200, 200], textColor: [0, 0, 0] },
                    margin: { left: margin, right: margin, bottom: margin },
                    didDrawPage: (data: any) => {
                        drawHeader(pdf);
                    }
                });
                y = (pdf as any).lastAutoTable.finalY + lineSpacing;
            });
        }
        
        drawUserSignature(pdf, getCurrentUser()!);
    };
    
    const generateMedicalDischarge = (pdf: jsPDF, patientData: any, user: UserProfile) => {
        const patientName = patientData.hemodinamia?.apellido && patientData.hemodinamia?.nombres ?
            `${patientData.hemodinamia.apellido.toUpperCase()}, ${patientData.hemodinamia.nombres}` :
            '';
        
        pdf.addPage();
        drawHeader(pdf);
        let y = 45;
        pdf.setFontSize(14).text('ALTA MEDICA', pdf.internal.pageSize.getWidth() / 2, y, { align: 'center' });
        y += lineSpacing * 3;
        pdf.setFontSize(10).setTextColor(0,0,0);
        drawField(pdf, 'PACIENTE:', patientName, y);
        drawField(pdf, 'DNI:', patientData.hemodinamia?.dni, y, 115, 140);
        y += lineSpacing;
        drawField(pdf, 'FECHA DE ALTA:', patientData.dischargeTimestamp ? new Date(patientData.dischargeTimestamp).toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '', y);
        
        y += lineSpacing * 2;
        drawTextArea(pdf, 'EPICRISIS:', patientData.evolucion?.epicrisis || '', y, 10);
        
        y += lineSpacing;
        drawTextArea(pdf, 'Recomendaciones y Prescripciones:', patientData['cirugia-anestesia']?.prescripciones_alta || '', y, 5);

        y += lineSpacing * 2;
        pdf.text('Recibe el paciente de conformidad:', margin, y);
        y += lineSpacing;
        pdf.line(margin, y, margin + 70, y);
        pdf.text('Firma', margin + 30, y + 4, { align: 'center' });
        
        drawUserSignature(pdf, user);
    };
    
    const generateGeneralReport = (pdf: jsPDF, patientData: any, user: UserProfile) => {
        pdf.addPage();
        drawHeader(pdf);
        
        let y = 45;
        pdf.setFontSize(14).text('REPORTE MEDICO GENERAL', pdf.internal.pageSize.getWidth() / 2, y, { align: 'center' });
        y += lineSpacing * 3;
        
        const patientName = patientData.hemodinamia?.apellido && patientData.hemodinamia?.nombres ?
            `${patientData.hemodinamia.apellido.toUpperCase()}, ${patientData.hemodinamia.nombres}` :
            '';
        
        pdf.setFontSize(10);
        drawField(pdf, 'PACIENTE:', patientName, y);
        drawField(pdf, 'DNI:', patientData.hemodinamia?.dni, y, 115, 140);
        y += lineSpacing;
        drawField(pdf, 'FECHA DE INGRESO:', patientData.hemodinamia?.ingreso, y);
        drawField(pdf, 'FECHA DE EGRESO:', patientData.dischargeTimestamp ? new Date(patientData.dischargeTimestamp).toLocaleDateString('es-ES') : 'N/A', y, 115, 140);

        y += lineSpacing * 2;
        pdf.setFontSize(12).text('Datos de Paciente', margin, y);
        y += lineSpacing;
        drawField(pdf, 'Edad:', patientData.hemodinamia?.edad, y);
        drawField(pdf, 'Sexo:', patientData.hemodinamia?.sexo, y, 115, 140);
        y += lineSpacing;
        drawField(pdf, 'Obra Social:', patientData.hemodinamia?.obraSocial, y);
        drawField(pdf, 'Médico de Cabecera:', patientData.hemodinamia?.medicoCabecera, y, 115, 140);
        
        y += lineSpacing * 2;
        pdf.setFontSize(12).text('Síntesis del Caso', margin, y);
        y += lineSpacing;
        drawTextArea(pdf, '', patientData.hemodinamia?.sintesisCaso || '', y, 5);
        
        if (patientData.evolucion) {
            pdf.addPage();
            drawHeader(pdf);
            let pageY = 45;
            pdf.setFontSize(12).text('Evolución y Notas', margin, pageY);
            pageY += lineSpacing;
            drawTextArea(pdf, '', patientData.evolucion.evolucion_notas || '', pageY, 15);
        }

        if (patientData['cirugia-anestesia']?.prescripciones) {
            pdf.addPage();
            drawHeader(pdf);
            let pageY = 45;
            pdf.setFontSize(12).text('Prescripciones', margin, pageY);
            pageY += lineSpacing;
            drawTextArea(pdf, '', patientData['cirugia-anestesia']?.prescripciones || '', pageY, 15);
        }

        drawUserSignature(pdf, user);
    };

    generateAltaBtn?.addEventListener('click', async () => {
        const btn = generateAltaBtn as HTMLButtonElement;
        const activeContent = document.querySelector('.tab-content.active');
        const form = activeContent?.querySelector('form');
        if (!form || !form.checkValidity()) {
            alert('Por favor, complete todos los campos obligatorios antes de generar el PDF.');
            form?.reportValidity();
            return;
        }

        const originalButtonText = btn.textContent;
        btn.textContent = 'Generando...';
        btn.disabled = true;

        const user = getCurrentUser();
        try {
            if (!activeContent || !user) {
                throw new Error("No active tab content found or user not logged in");
            }
            
            const dniInput = activeContent.querySelector('input[id$="-dni"]') as HTMLInputElement;
            const dni = dniInput.value.trim();

            if (!dni) {
                throw new Error('No se puede generar el PDF sin un DNI de paciente.');
            }

            const patientData = await apiGetPatientByDni(dni);

            if (!patientData) {
                throw new Error('No se encontraron datos para el paciente para generar el PDF.');
            }

            const pdf = new jsPDF('p', 'mm', 'a4');
            
            // --- Patient Information Tab ---
            if (patientData.hemodinamia) {
                generateAndRenderPage(
                    pdf,
                    patientData.hemodinamia,
                    'REPORTE DE HEMODINAMIA',
                    [
                        { label: 'PACIENTE:', key: 'nombres' },
                        { label: 'DNI:', key: 'dni' },
                        { label: 'FECHA DE INGRESO:', key: 'ingreso' },
                        { label: 'EDAD:', key: 'edad' },
                        { label: 'SEXO:', key: 'sexo' },
                        { label: 'DIAGNOSTICO:', key: 'diagnostico' },
                        { label: 'ESTUDIOS:', key: 'estudios' },
                        { label: 'TIPO DE PACIENTE:', key: 'tipoPaciente' }
                    ],
                    [
                        { label: 'SÍNTESIS DEL CASO:', key: 'sintesisCaso', lines: 10 }
                    ]
                );
            }
            
            // --- Endoscopic Group Tab ---
            if (patientData['grupo-endoscopico']) {
                generateAndRenderPage(
                    pdf,
                    patientData['grupo-endoscopico'],
                    'GRUPO ENDOSCOPICO',
                    [
                        { label: 'PACIENTE:', key: 'nombres' },
                        { label: 'DNI:', key: 'dni' },
                        { label: 'FECHA:', key: 'fecha' },
                        { label: 'ESTUDIO:', key: 'estudio' },
                        { label: 'MEDICACION:', key: 'medicacion' },
                    ],
                    [
                        { label: 'SÍNTESIS DEL CASO:', key: 'sintesis', lines: 10 }
                    ]
                );
            }
            
            // --- Surgeries Tab ---
            if (patientData.cirugias) {
                generateAndRenderPage(
                    pdf,
                    patientData.cirugias,
                    'CIRUGIAS Y PROCEDIMIENTOS',
                    [
                        { label: 'PACIENTE:', key: 'nombres' },
                        { label: 'DNI:', key: 'dni' },
                        { label: 'FECHA:', key: 'fecha' },
                        { label: 'DIAGNOSTICO:', key: 'diagnostico' },
                        { label: 'PROCEDIMIENTO:', key: 'procedimiento' }
                    ],
                    [
                        { label: 'SÍNTESIS Y HALLAZGOS:', key: 'sintesis', lines: 10 }
                    ]
                );
            }
            
            // --- Anesthesia & Discharge Tab ---
            if (patientData['cirugia-anestesia']) {
                generateAndRenderPage(
                    pdf,
                    patientData['cirugia-anestesia'],
                    'PROTOCOLO DE ANESTESIA Y EVOLUCIÓN',
                    [
                        { label: 'PACIENTE:', key: 'nombres' },
                        { label: 'DNI:', key: 'dni' },
                        { label: 'FECHA:', key: 'fecha' },
                        { label: 'ANESTESIA:', key: 'anestesia' },
                        { label: 'PROCEDIMIENTO:', key: 'procedimiento' },
                        { label: 'DIAGNOSTICO:', key: 'diagnostico' },
                    ],
                    [
                        { label: 'EVOLUCIÓN Y OBSERVACIONES:', key: 'evolucion', lines: 10 }
                    ],
                    [
                        {
                            tableName: 'Monitoreo intraoperatorio',
                            key: 'monitoreo',
                            columns: ['Hora', 'Sistólica', 'Diastólica', 'Pulso'],
                            rowsMap: (row: any) => [row['Monitoreo Hora'], row['Monitoreo Sistolica'], row['Monitoreo Diastolica'], row['Monitoreo Pulso']]
                        },
                        {
                            tableName: 'Prescripciones',
                            key: 'prescripciones',
                            columns: ['Fecha', 'Indicaciones'],
                            rowsMap: (row: any) => [row['Prescripcion Fecha'], row['Prescripcion Indicaciones']]
                        }
                    ],
                );
                
                if (patientData['cirugia-anestesia']?.escaneado_alta) {
                    try {
                        const uploadedPdfBytes = await fetch(patientData['cirugia-anestesia'].escaneado_alta).then(res => res.arrayBuffer());
                        const uploadedPdfDoc = await PDFDocument.load(uploadedPdfBytes);
                        const mainPdfDoc = await PDFDocument.load(pdf.output('arraybuffer'));
                        
                        const uploadedPagesIndices = Array.from({ length: uploadedPdfDoc.getPageCount() }, (_, i) => i);
                        const copiedPages = await mainPdfDoc.copyPages(uploadedPdfDoc, uploadedPagesIndices);
                        
                        copiedPages.forEach((page, index) => {
                            mainPdfDoc.addPage(page);
                        });
                        
                        const finalMergedPdfBytes = await mainPdfDoc.save();
                        const mergedPdfBlob = new Blob([finalMergedPdfBytes], { type: 'application/pdf' });
                        const mergedPdfUrl = URL.createObjectURL(mergedPdfBlob);
                        
                        const mergedLink = document.createElement('a');
                        mergedLink.href = mergedPdfUrl;
                        mergedLink.download = `reporte-paciente-${dni}-anestesia.pdf`;
                        document.body.appendChild(mergedLink);
                        mergedLink.click();
                        document.body.removeChild(mergedLink);
                        URL.revokeObjectURL(mergedPdfUrl);
                        
                    } catch (mergeError) {
                        console.error("Error merging PDFs:", mergeError);
                        alert("Error al combinar el PDF escaneado. Se generará el PDF sin el archivo adjunto.");
                    }
                } 
            }

            // Generate medical discharge and general report only if there's a discharge timestamp
            if (patientData.dischargeTimestamp) {
                generateMedicalDischarge(pdf, patientData, user);
                generateGeneralReport(pdf, patientData, user);
            }

            const finalPdfBytes = await pdf.output('arraybuffer');
            const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            const filename = `reporte-paciente-${dni}.pdf`;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(link.href);

            await setDischargeTimestamp();
            
        } catch (error: any) {
            console.error("PDF Generation Error:", error);
            alert(`Ocurrió un error al generar el PDF. Detalles: ${error.message}`);
        } finally {
            btn.textContent = originalButtonText;
            btn.disabled = false;
        }
    });
});