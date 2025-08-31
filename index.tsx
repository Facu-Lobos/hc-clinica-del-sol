/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import jsPDF from 'jspdf';
import { PDFDocument } from 'pdf-lib';

// --- Supabase Setup ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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
                    alert('Alta generada exitosamente. Este registro se bloqueará para edición en 24 horas.');
                }
            } catch (error) {
                console.error('Failed to set discharge timestamp', error);
                alert('Error al registrar la fecha de alta.');
            }
        }
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
            
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageHeight = pdf.internal.pageSize.getHeight();
            const pageWidth = pdf.internal.pageSize.getWidth();
            const margin = 15;
            const fieldMargin = 45;
            const lineSpacing = 8;
            let y = 0;

            const drawHeader = () => {
                const logoY = 20;
                const logoRadius = 7;
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
                pdf.line(logoX - crossSize, logoY, logoX + crossSize, logoY);
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
            const drawField = (label: string, value: string, yPos: number, xStart: number = margin, xValStart?: number) => {
                pdf.text(label, xStart, yPos);
                pdf.text(value, xValStart || (xStart + fieldMargin), yPos);
            };
            const drawCenteredField = (label: string, value: string, yPos: number) => {
                pdf.setFontSize(10);
                const gap = 4;
                const labelWidth = pdf.getTextWidth(label);
                const labelX = (pageWidth / 2) - (gap / 2) - labelWidth;
                const valueX = (pageWidth / 2) + (gap / 2);
                pdf.text(label, labelX, yPos);
                pdf.text(value, valueX, yPos);
            };
            const drawTextArea = (label: string, textContent: string[], startY: number, numLines: number) => {
                pdf.text(label, margin, startY);
                pdf.setLineDashPattern([1, 1], 0);
                let lineY = startY + 4;
                const lineHeight = 5;
                for (let i = 0; i < numLines; i++) {
                    const middleY = lineY + lineHeight / 2;
                    if (i < textContent.length) {
                        pdf.text(textContent[i], margin, middleY, { baseline: 'middle', maxWidth: pageWidth - margin * 2 });
                    }
                    pdf.line(margin, lineY, pageWidth - margin, lineY);
                    lineY += lineHeight;
                }
                pdf.setLineDashPattern([], 0);
                return lineY + 4;
            };
            const drawUserSignature = () => {
                const loggedInUser = getCurrentUser();
                if (loggedInUser) {
                    const signatureY = pageHeight - 25;
                    const signatureXStart = pageWidth - margin - 70;
                    pdf.setDrawColor(150);
                    pdf.line(signatureXStart, signatureY, pageWidth - margin, signatureY);
            
                    if (loggedInUser.firma) {
                        try {
                            const signatureWidth = 35;
                            const signatureHeight = 12;
                            pdf.addImage(loggedInUser.firma, 'PNG', signatureXStart + 5, signatureY - signatureHeight, signatureWidth, signatureHeight);
                        } catch (e) {
                            console.error("Could not add signature image to PDF", e);
                        }
                    }
            
                    pdf.setFontSize(8).setTextColor(100);
                    const signatureText = `${loggedInUser.nombre} ${loggedInUser.apellido}`;
                    const specialtyText = `(${loggedInUser.especialidad})`;
                    
                    pdf.text(signatureText, signatureXStart, signatureY + 4);
                    pdf.text(specialtyText, signatureXStart, signatureY + 8);
                    
                    pdf.setFontSize(10).setTextColor(0,0,0);
                    pdf.setDrawColor(0);
                }
            };
            const drawMedicalDischargePage = (patientName: string, patientDNI: string) => {
                pdf.addPage();
                drawHeader();
                let y = 45;

                pdf.setFontSize(14).text('ALTA MEDICA', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;

                pdf.setFontSize(10).setTextColor(0,0,0);
                drawField('PACIENTE:', patientName, y);
                drawField('DNI:', patientDNI, y, 115, 140);
                y += lineSpacing;
                drawField('FECHA DE ALTA:', new Date().toLocaleDateString('es-ES', { year: 'numeric', month: '2-digit', day: '2-digit' }), y);
                y += lineSpacing * 2;

                const dischargeText = "Se otorga el alta médica al paciente, con indicación de continuar tratamiento y seguimiento de forma ambulatoria según las siguientes indicaciones:";
                const splitText = pdf.splitTextToSize(dischargeText, pageWidth - margin * 2);
                pdf.text(splitText, margin, y);
                y += splitText.length * 4 + lineSpacing;
                
                y = drawTextArea('INDICACIONES:', [], y, 15);
                
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') {
                    drawUserSignature();
                } else {
                    const signatureY = pageHeight - 40;
                    const signatureXStart = pageWidth - margin - 80;
                    pdf.setDrawColor(0);
                    pdf.line(signatureXStart, signatureY, pageWidth - margin, signatureY);
                    pdf.setFontSize(8).setTextColor(100);
                    pdf.text("Firma y Sello del Médico Responsable", signatureXStart, signatureY + 4);
                }
            };

            // --- Conditional PDF Generation ---
            if (activeContent.id === 'hemodinamia') {
                const prefix = 'hd-';
                const getValue = (id: string) => (document.getElementById(prefix + id) as HTMLInputElement)?.value || '....................';
                const getTextAreaValue = (id: string) => {
                    const value = (document.getElementById(prefix + id) as HTMLTextAreaElement)?.value || '';
                    return pdf.splitTextToSize(value, pageWidth - margin * 2);
                };
                
                // --- PAGE 1 ---
                drawHeader();
                y = 45;
                pdf.setFontSize(10).setTextColor(0,0,0);
                pdf.setFontSize(12).text('DATOS DEL PACIENTE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                drawField('MEDICO:', getValue('medico'), y);
                drawField('HC N°:', getValue('hc-n'), y, 115, 140);
                y += lineSpacing;
                drawField('APELLIDO:', getValue('apellido'), y);
                drawField('EDAD:', getValue('edad'), y, 115, 140);
                y += lineSpacing;
                drawField('NOMBRES:', getValue('nombres'), y);
                drawField('DNI:', getValue('dni'), y, 115, 140);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('domicilio'), y);
                y += lineSpacing;
                drawField('TELEFONO:', getValue('telefono'), y);
                drawField('EST. CIVIL:', getValue('estado-civil'), y, 115, 140);
                y += lineSpacing;
                drawField('COB SOCIAL:', getValue('cob-social'), y);
                drawField('N° AF:', getValue('n-afiliado'), y, 115, 140);
                y += lineSpacing;
                drawField('CONDICION AL IVA:', getValue('iva'), y);
                y = 135;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FAMILIAR RESPONSABLE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                pdf.setFontSize(10);
                drawField('APELLIDO Y NOMBRE:', getValue('fam-nombre'), y);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('fam-domicilio'), y);
                y += lineSpacing;
                drawField('TEL:', getValue('fam-tel'), y);
                drawField('DNI:', getValue('fam-dni'), y, 115, 140);
                y = 220;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FECHAS', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 2;
                pdf.setFontSize(10);
                drawField('FECHA DE INGRESO:', getValue('fecha-ingreso'), y);
                drawField('HORA:', getValue('hora-ingreso'), y, 115, 140);
                y += lineSpacing;
                drawField('FECHA DE EGRESO:', getValue('fecha-egreso'), y);
                drawField('HORA:', getValue('hora-egreso'), y, 115, 140);
                if (user?.especialidad === 'Administrativo' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 2 ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('INGRESO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.setFontSize(10).setTextColor(0,0,0);
                drawField('PACIENTE:', getValue('paciente-2'), y);
                drawField('HC:', getValue('hc-2'), y, 115, 140);
                y += lineSpacing;
                drawField('SERVICIO:', getValue('servicio'), y);
                drawField('FECHA:', getValue('fecha-2'), y, 115, 140);
                y += lineSpacing;
                drawField('HABITACION:', getValue('habitacion'), y);
                drawField('CAMA:', getValue('cama'), y, 115, 140);
                y += lineSpacing * 2;
                y = drawTextArea('MOTIVO DE INTERNACION:', getTextAreaValue('motivo-internacion'), y, 3);
                y = drawTextArea('DIAGNOSTICO PRESUNTIVO:', getTextAreaValue('diagnostico-presuntivo'), y, 4);
                y = drawTextArea('ESTADO ACTUAL:', getTextAreaValue('estado-actual'), y, 4);
                y = drawTextArea('ANTECEDENTES:', getTextAreaValue('antecedentes'), y, 4);
                y += lineSpacing;
                pdf.setFontSize(14).text('EXAMEN FISICO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing;
                y = drawTextArea('CABEZA Y CUELLO:', getTextAreaValue('cabeza-cuello'), y, 2);
                drawTextArea('APARATO RESPIRATORIO:', getTextAreaValue('aparato-respiratorio'), y, 2);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 3 ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                y = drawTextArea('APARATO CARDIOVASCULAR:', getTextAreaValue('aparato-cardiovascular'), y, 4);
                y = drawTextArea('APARATO DIGESTIVO:', getTextAreaValue('aparato-digestivo'), y, 4);
                y = drawTextArea('APARATO LOCOMOTOR:', getTextAreaValue('aparato-locomotor'), y, 4);
                y = drawTextArea('APARATO GENITOUTERINO:', getTextAreaValue('aparato-genitourinario'), y, 4);
                y = drawTextArea('SISTEMA NERVIOSO:', getTextAreaValue('sistema-nervioso'), y, 4);
                y = drawTextArea('OBSERVACIONES:', getTextAreaValue('observaciones'), y, 4);
                y = drawTextArea('ESTUDIOS COMPLEMENTARIOS:', getTextAreaValue('estudios-complementarios'), y, 4);
                drawTextArea('TRATAMENTO:', getTextAreaValue('tratamiento'), y, 4);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();
                
                // --- PAGE 4 ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                pdf.setFontSize(14).text('PARTE QUIRURGICO HOJA 2', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawCenteredField('PACIENTE:', getValue('paciente-4'), y);
                y += lineSpacing;
                drawTextArea('', getTextAreaValue('reporte-quirurgico'), y, 25);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();
                
                // --- PAGE 5 ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                pdf.setFontSize(12).text('PRACTICAS MEDICAS', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawCenteredField('PACIENTE:', getValue('paciente-5'), y);
                y += lineSpacing;
                drawCenteredField('MEDICO DE CABECERA:', getValue('medico-cabecera'), y);
                y += lineSpacing;
                const practicasHeaders = ["Fecha", "Código", "Descripción", "Cant.", "Observación"];
                const practicasColWidths = [30, 20, 50, 15, 70];
                const practicasTableBody = activeContent.querySelector('.practicas-medicas-table tbody');
                pdf.setDrawColor(0).setLineWidth(0.2);
                pdf.rect(margin, y, pageWidth - margin * 2, 8);
                let currentX = margin;
                for(let i = 0; i < practicasHeaders.length; i++) {
                    pdf.text(practicasHeaders[i], currentX + 2, y + 4, { baseline: 'middle' });
                    currentX += practicasColWidths[i];
                    if (i < practicasHeaders.length - 1) pdf.line(currentX, y, currentX, y + 23 * 8);
                }
                y += 8;
                const practicasRows = practicasTableBody?.querySelectorAll('tr');
                for(let i = 0; i < 22; i++) {
                    pdf.rect(margin, y, pageWidth - margin * 2, 8);
                    if (practicasRows && i < practicasRows.length) {
                        const cells = practicasRows[i].querySelectorAll('input');
                        currentX = margin;
                        for(let j = 0; j < cells.length; j++) {
                            pdf.text(cells[j].value, currentX + 2, y + 4, { baseline: 'middle', maxWidth: practicasColWidths[j] - 4 });
                            currentX += practicasColWidths[j];
                        }
                    }
                    y += 8;
                }
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 6 ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                pdf.setFontSize(12).text('CONTROL DE ENFERMERIA', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawCenteredField('PACIENTE:', getValue('paciente-6'), y);
                y += lineSpacing;
                const enfermeriaHeaders = ["Fecha", "Hora", "T.A.", "F.C.", "F.R.", "Temp.", "Observaciones"];
                const enfermeriaColWidths = [30, 15, 15, 15, 15, 15, 75];
                const enfermeriaTableBody = activeContent.querySelector('.enfermeria-table tbody');
                pdf.rect(margin, y, pageWidth - margin * 2, 8);
                currentX = margin;
                for(let i = 0; i < enfermeriaHeaders.length; i++) {
                    pdf.text(enfermeriaHeaders[i], currentX + 2, y + 4, { baseline: 'middle' });
                    currentX += enfermeriaColWidths[i];
                     if (i < enfermeriaHeaders.length - 1) pdf.line(currentX, y, currentX, y + 17 * 12);
                }
                y += 8;
                const enfermeriaRows = enfermeriaTableBody?.querySelectorAll('tr');
                for(let i = 0; i < 16; i++) {
                     pdf.rect(margin, y, pageWidth - margin * 2, 12);
                     if(enfermeriaRows && i < enfermeriaRows.length) {
                        const cells = enfermeriaRows[i].querySelectorAll('input');
                        currentX = margin;
                        for(let j = 0; j < cells.length; j++) {
                            pdf.text(cells[j].value, currentX + 2, y + 6, { baseline: 'middle', maxWidth: enfermeriaColWidths[j] - 4 });
                            currentX += enfermeriaColWidths[j];
                        }
                     }
                     y += 12;
                }
                if (user?.especialidad === 'Enfermero' || user?.especialidad === 'Administrador') drawUserSignature();
                
                const patientName = `${getValue('apellido')}, ${getValue('nombres')}`;
                const patientDNI = getValue('dni');
                drawMedicalDischargePage(patientName, patientDNI);
                
                pdf.save(`hemodinamia-${getValue('apellido')}-${getValue('dni')}.pdf`);
                await setDischargeTimestamp();

            } else if (activeContent.id === 'grupo-endoscopico') {
                const prefix = 'ge-';
                const getValue = (id: string) => (document.getElementById(prefix + id) as HTMLInputElement)?.value || '....................';
                const getTextAreaValue = (id: string) => {
                    const value = (document.getElementById(prefix + id) as HTMLTextAreaElement)?.value || '';
                    return pdf.splitTextToSize(value, pageWidth - margin * 2);
                };

                // --- PAGE 1 (Same as Hemodinamia) ---
                drawHeader();
                y = 45;
                pdf.setFontSize(10).setTextColor(0,0,0);
                pdf.setFontSize(12).text('DATOS DEL PACIENTE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                drawField('MEDICO:', getValue('medico'), y);
                drawField('HC N°:', getValue('hc-n'), y, 115, 140);
                y += lineSpacing;
                drawField('APELLIDO:', getValue('apellido'), y);
                drawField('EDAD:', getValue('edad'), y, 115, 140);
                y += lineSpacing;
                drawField('NOMBRES:', getValue('nombres'), y);
                drawField('DNI:', getValue('dni'), y, 115, 140);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('domicilio'), y);
                y += lineSpacing;
                drawField('TELEFONO:', getValue('telefono'), y);
                drawField('EST. CIVIL:', getValue('estado-civil'), y, 115, 140);
                y += lineSpacing;
                drawField('COB SOCIAL:', getValue('cob-social'), y);
                drawField('N° AF:', getValue('n-afiliado'), y, 115, 140);
                y += lineSpacing;
                drawField('CONDICION AL IVA:', getValue('iva'), y);
                y = 135;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FAMILIAR RESPONSABLE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                pdf.setFontSize(10);
                drawField('APELLIDO Y NOMBRE:', getValue('fam-nombre'), y);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('fam-domicilio'), y);
                y += lineSpacing;
                drawField('TEL:', getValue('fam-tel'), y);
                drawField('DNI:', getValue('fam-dni'), y, 115, 140);
                y = 220;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FECHAS', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 2;
                pdf.setFontSize(10);
                drawField('FECHA DE INGRESO:', getValue('fecha-ingreso'), y);
                drawField('HORA:', getValue('hora-ingreso'), y, 115, 140);
                y += lineSpacing;
                drawField('FECHA DE EGRESO:', getValue('fecha-egreso'), y);
                drawField('HORA:', getValue('hora-egreso'), y, 115, 140);
                if (user?.especialidad === 'Administrativo' || user?.especialidad === 'Administrador') drawUserSignature();
                
                // --- PAGE 2 (Same as Hemodinamia) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('INGRESO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.setFontSize(10).setTextColor(0,0,0);
                drawField('PACIENTE:', getValue('paciente-2'), y);
                drawField('HC:', getValue('hc-2'), y, 115, 140);
                y += lineSpacing;
                drawField('SERVICIO:', getValue('servicio'), y);
                drawField('FECHA:', getValue('fecha-2'), y, 115, 140);
                y += lineSpacing;
                drawField('HABITACION:', getValue('habitacion'), y);
                drawField('CAMA:', getValue('cama'), y, 115, 140);
                y += lineSpacing * 2;
                y = drawTextArea('MOTIVO DE INTERNACION:', getTextAreaValue('motivo-internacion'), y, 3);
                y = drawTextArea('DIAGNOSTICO PRESUNTIVO:', getTextAreaValue('diagnostico-presuntivo'), y, 4);
                y = drawTextArea('ESTADO ACTUAL:', getTextAreaValue('estado-actual'), y, 4);
                y = drawTextArea('ANTECEDENTES:', getTextAreaValue('antecedentes'), y, 4);
                y += lineSpacing;
                pdf.setFontSize(14).text('EXAMEN FISICO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing;
                y = drawTextArea('CABEZA Y CUELLO:', getTextAreaValue('cabeza-cuello'), y, 2);
                drawTextArea('APARATO RESPIRATORIO:', getTextAreaValue('aparato-respiratorio'), y, 2);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 3 (Same as Hemodinamia) ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                y = drawTextArea('APARATO CARDIOVASCULAR:', getTextAreaValue('aparato-cardiovascular'), y, 4);
                y = drawTextArea('APARATO DIGESTIVO:', getTextAreaValue('aparato-digestivo'), y, 4);
                y = drawTextArea('APARATO LOCOMOTOR:', getTextAreaValue('aparato-locomotor'), y, 4);
                y = drawTextArea('APARATO GENITOUTERINO:', getTextAreaValue('aparato-genitourinario'), y, 4);
                y = drawTextArea('SISTEMA NERVIOSO:', getTextAreaValue('sistema-nervioso'), y, 4);
                y = drawTextArea('OBSERVACIONES:', getTextAreaValue('observaciones'), y, 4);
                y = drawTextArea('ESTUDIOS COMPLEMENTARIOS:', getTextAreaValue('estudios-complementarios'), y, 4);
                drawTextArea('TRATAMENTO:', getTextAreaValue('tratamiento'), y, 4);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 4 (Evolucion) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('EVOLUCION', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.setDrawColor(0).setLineWidth(0.2);
                pdf.rect(margin, y, pageWidth - margin * 2, 10);
                drawField('PACIENTE:', getValue('paciente-evolucion'), y + 6, margin + 2, margin + 22);
                y += 10;
                const evolucionText = getTextAreaValue('evolucion-notas');
                const lineHeight = 10;
                const numLines = 22;
                for (let i = 0; i < numLines; i++) {
                    pdf.rect(margin, y, pageWidth - margin * 2, lineHeight);
                    if (i < evolucionText.length) {
                        pdf.text(evolucionText[i], margin + 2, y + lineHeight / 2 + 1, { baseline: 'middle', maxWidth: pageWidth - (margin * 2) - 4 });
                    }
                    y += lineHeight;
                }
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 5 (Report) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('REPORT', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.rect(margin, y, pageWidth - margin * 2, 10); // Box for patient
                drawField('PACIENTE:', getValue('paciente-report'), y + 6, margin + 2, margin + 22);
                y += 10;
                pdf.rect(margin, y, pageWidth - margin * 2, 10); // Box for date, sala, cama
                drawField('FECHA:', getValue('fecha-report'), y + 6, margin + 2, margin + 18);
                drawField('SALA:', getValue('sala-report'), y + 6, pageWidth / 2 - 20, pageWidth / 2 - 8);
                drawField('CAMA:', getValue('cama-report'), y + 6, pageWidth / 2 + 50, pageWidth / 2 + 65);
                y += 15;
                const reportContent = getTextAreaValue('report-contenido');
                pdf.setLineDashPattern([1, 1], 0);
                let lineY = y;
                const reportLineHeight = 8;
                const reportNumLines = 25;
                for(let i = 0; i < reportNumLines; i++) {
                    if (i < reportContent.length) {
                        pdf.text(reportContent[i], margin, lineY, { baseline: 'middle', maxWidth: pageWidth - margin * 2 });
                    }
                    pdf.line(margin, lineY, pageWidth - margin, lineY);
                    lineY += reportLineHeight;
                }
                pdf.setLineDashPattern([], 0);
                if (user?.especialidad === 'Enfermero' || user?.especialidad === 'Administrador') drawUserSignature();

                const patientName = `${getValue('apellido')}, ${getValue('nombres')}`;
                const patientDNI = getValue('dni');
                drawMedicalDischargePage(patientName, patientDNI);

                pdf.save(`grupo-endoscopico-${getValue('apellido')}-${getValue('dni')}.pdf`);
                await setDischargeTimestamp();

            } else if (activeContent.id === 'cirugias') {
                const prefix = 'cg-';
                const getValue = (id: string) => (document.getElementById(prefix + id) as HTMLInputElement)?.value || '....................';
                const getTextAreaValue = (id: string) => {
                    const value = (document.getElementById(prefix + id) as HTMLTextAreaElement)?.value || '';
                    return pdf.splitTextToSize(value, pageWidth - margin * 2);
                };

                // --- PAGE 1 (Standard) ---
                drawHeader();
                y = 45;
                pdf.setFontSize(10).setTextColor(0,0,0);
                pdf.setFontSize(12).text('DATOS DEL PACIENTE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                drawField('MEDICO:', getValue('medico'), y);
                drawField('HC N°:', getValue('hc-n'), y, 115, 140);
                y += lineSpacing;
                drawField('APELLIDO:', getValue('apellido'), y);
                drawField('EDAD:', getValue('edad'), y, 115, 140);
                y += lineSpacing;
                drawField('NOMBRES:', getValue('nombres'), y);
                drawField('DNI:', getValue('dni'), y, 115, 140);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('domicilio'), y);
                y += lineSpacing;
                drawField('TELEFONO:', getValue('telefono'), y);
                drawField('EST. CIVIL:', getValue('estado-civil'), y, 115, 140);
                y += lineSpacing;
                drawField('COB SOCIAL:', getValue('cob-social'), y);
                drawField('N° AF:', getValue('n-afiliado'), y, 115, 140);
                y += lineSpacing;
                drawField('CONDICION AL IVA:', getValue('iva'), y);
                y = 135;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FAMILIAR RESPONSABLE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                pdf.setFontSize(10);
                drawField('APELLIDO Y NOMBRE:', getValue('fam-nombre'), y);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('fam-domicilio'), y);
                y += lineSpacing;
                drawField('TEL:', getValue('fam-tel'), y);
                drawField('DNI:', getValue('fam-dni'), y, 115, 140);
                y = 220;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FECHAS', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 2;
                pdf.setFontSize(10);
                drawField('FECHA DE INGRESO:', getValue('fecha-ingreso'), y);
                drawField('HORA:', getValue('hora-ingreso'), y, 115, 140);
                y += lineSpacing;
                drawField('FECHA DE EGRESO:', getValue('fecha-egreso'), y);
                drawField('HORA:', getValue('hora-egreso'), y, 115, 140);
                if (user?.especialidad === 'Administrativo' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 2 (Standard) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('INGRESO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.setFontSize(10).setTextColor(0,0,0);
                drawField('PACIENTE:', getValue('paciente-2'), y);
                drawField('HC:', getValue('hc-2'), y, 115, 140);
                y += lineSpacing;
                drawField('SERVICIO:', getValue('servicio'), y);
                drawField('FECHA:', getValue('fecha-2'), y, 115, 140);
                y += lineSpacing;
                drawField('HABITACION:', getValue('habitacion'), y);
                drawField('CAMA:', getValue('cama'), y, 115, 140);
                y += lineSpacing * 2;
                y = drawTextArea('MOTIVO DE INTERNACION:', getTextAreaValue('motivo-internacion'), y, 3);
                y = drawTextArea('DIAGNOSTICO PRESUNTIVO:', getTextAreaValue('diagnostico-presuntivo'), y, 4);
                y = drawTextArea('ESTADO ACTUAL:', getTextAreaValue('estado-actual'), y, 4);
                y = drawTextArea('ANTECEDENTES:', getTextAreaValue('antecedentes'), y, 4);
                y += lineSpacing;
                pdf.setFontSize(14).text('EXAMEN FISICO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing;
                y = drawTextArea('CABEZA Y CUELLO:', getTextAreaValue('cabeza-cuello'), y, 2);
                drawTextArea('APARATO RESPIRATORIO:', getTextAreaValue('aparato-respiratorio'), y, 2);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 3 (Standard) ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                y = drawTextArea('APARATO CARDIOVASCULAR:', getTextAreaValue('aparato-cardiovascular'), y, 4);
                y = drawTextArea('APARATO DIGESTIVO:', getTextAreaValue('aparato-digestivo'), y, 4);
                y = drawTextArea('APARATO LOCOMOTOR:', getTextAreaValue('aparato-locomotor'), y, 4);
                y = drawTextArea('APARATO GENITOUTERINO:', getTextAreaValue('aparato-genitourinario'), y, 4);
                y = drawTextArea('SISTEMA NERVIOSO:', getTextAreaValue('sistema-nervioso'), y, 4);
                y = drawTextArea('OBSERVACIONES:', getTextAreaValue('observaciones'), y, 4);
                y = drawTextArea('ESTUDIOS COMPLEMENTARIOS:', getTextAreaValue('estudios-complementarios'), y, 4);
                drawTextArea('TRATAMENTO:', getTextAreaValue('tratamiento'), y, 4);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 4 (Parte Quirurgico) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('PARTE QUIRURGICO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 1;
                pdf.setDrawColor(0).setLineWidth(0.2);
                
                // Top Box
                pdf.rect(margin, y, pageWidth - margin * 2, 20);
                const contentWidth = pageWidth - margin * 2;
                const firstDividerX = margin + contentWidth *1.5 / 3;
                const secondDividerX = firstDividerX + (contentWidth / 1.7) / 2;

                // Vertical dividers
                pdf.line(firstDividerX, y, firstDividerX, y + 20);
                pdf.line(secondDividerX, y, secondDividerX, y + 20);
                // Horizontal divider
                pdf.line(margin, y + 10, pageWidth - margin, y + 10);
                
                // Fields in the box - Corrected Alignment
                drawField('PACIENTE:', getValue('paciente-4'), y + 6, margin + 2, margin + 30);
                drawField('GRUPO:', getValue('grupo'), y + 6, firstDividerX + 2, firstDividerX + 23);
                drawField('RH:', getValue('rh'), y + 6, secondDividerX + 2, secondDividerX + 17);
                
                drawField('SERVICIO:', getValue('servicio-4'), y + 16, margin + 2, margin + 30);
                drawField('HAB:', getValue('hab-4'), y + 16, firstDividerX + 2, firstDividerX + 18);
                drawField('CAMA:', getValue('cama-4'), y + 16, secondDividerX + 2, secondDividerX + 20);

                y += lineSpacing * 1;
                y += 25;
                drawField('FECHA CIRUGIA:', getValue('fecha-cirugia'), y);
                drawField('HORA:', getValue('hora-cirugia'), y, 115, 140);
                y += lineSpacing;
                drawField('CIRUJANO:', getValue('cirujano'), y);
                y += lineSpacing;
                drawField('AYUDANTE 1:', getValue('ayudante1'), y);
                drawField('AYUDANTE 2:', getValue('ayudante2'), y, 115, 150);
                y += lineSpacing;
                drawField('PEDIATRA:', getValue('pediatra'), y);
                drawField('ANESTESISTA:', getValue('anestesista'), y, 115, 155);
                y += lineSpacing * 1.5;

                y = drawTextArea('DIAGNOSTICO PREOPERATORIO:', getTextAreaValue('diagnostico-preop'), y, 4);
                y = drawTextArea('OPERACIÓN PRACTICADA:', getTextAreaValue('operacion-practicada'), y, 4);
                drawTextArea('DETALLES DE LA TECNICA:', getTextAreaValue('detalles-tecnica'), y, 8);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();
                
                // --- PAGE 5 (Parte Quirurgico Hoja 2) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('PARTE QUIRURGICO HOJA 2', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawField('PACIENTE:', getValue('paciente-5'), y);
                y += lineSpacing * 1.5;
                drawTextArea('', getTextAreaValue('detalles-quirurgico-2'), y, 38);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 6 (Evolucion) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('EVOLUCION', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.setDrawColor(0).setLineWidth(0.2);
                pdf.rect(margin, y, pageWidth - margin * 2, 10);
                drawField('PACIENTE:', getValue('paciente-evolucion'), y + 6, margin + 2, margin +29);
                y += 10;
                const evolucionTextCG = getTextAreaValue('evolucion-notas');
                const lineHeightCG = 10;
                const numLinesCG = 22;
                for (let i = 0; i < numLinesCG; i++) {
                    pdf.rect(margin, y, pageWidth - margin * 2, lineHeightCG);
                    if (i < evolucionTextCG.length) {
                        pdf.text(evolucionTextCG[i], margin + 2, y + lineHeightCG / 2 + 1, { baseline: 'middle', maxWidth: pageWidth - (margin * 2) - 4 });
                    }
                    y += lineHeightCG;
                }
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                const patientName = `${getValue('apellido')}, ${getValue('nombres')}`;
                const patientDNI = getValue('dni');
                drawMedicalDischargePage(patientName, patientDNI);

                pdf.save(`cirugias-${getValue('apellido')}-${getValue('dni')}.pdf`);
                await setDischargeTimestamp();

            } else if (activeContent.id === 'cirugia-anestesia') {
                const prefix = 'ca-';
                const getValue = (id: string) => (document.getElementById(prefix + id) as HTMLInputElement)?.value || '';
                const getTextAreaValue = (id: string) => {
                    const value = (document.getElementById(prefix + id) as HTMLTextAreaElement)?.value || '';
                    return pdf.splitTextToSize(value, pageWidth - margin * 2);
                };
                
                const scannedProtocolInput = document.getElementById('ca-protocolo-escaneado') as HTMLInputElement;
                const scannedFile = scannedProtocolInput.files ? scannedProtocolInput.files[0] : null;

                // --- PAGE 1 (Standard) ---
                drawHeader();
                y = 45;
                pdf.setFontSize(10).setTextColor(0,0,0);
                pdf.setFontSize(12).text('DATOS DEL PACIENTE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                drawField('MEDICO:', getValue('medico'), y);
                drawField('HC N°:', getValue('hc-n'), y, 115, 140);
                y += lineSpacing;
                drawField('APELLIDO:', getValue('apellido'), y);
                drawField('EDAD:', getValue('edad'), y, 115, 140);
                y += lineSpacing;
                drawField('NOMBRES:', getValue('nombres'), y);
                drawField('DNI:', getValue('dni'), y, 115, 140);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('domicilio'), y);
                y += lineSpacing;
                drawField('TELEFONO:', getValue('telefono'), y);
                drawField('EST. CIVIL:', getValue('estado-civil'), y, 115, 140);
                y += lineSpacing;
                drawField('COB SOCIAL:', getValue('cob-social'), y);
                drawField('N° AF:', getValue('n-afiliado'), y, 115, 140);
                y += lineSpacing;
                drawField('CONDICION AL IVA:', getValue('iva'), y);
                y = 135;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FAMILIAR RESPONSABLE', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 3;
                pdf.setFontSize(10);
                drawField('APELLIDO Y NOMBRE:', getValue('fam-nombre'), y);
                y += lineSpacing;
                drawField('DOMICILIO:', getValue('fam-domicilio'), y);
                y += lineSpacing;
                drawField('TEL:', getValue('fam-tel'), y);
                drawField('DNI:', getValue('fam-dni'), y, 115, 140);
                y = 220;
                pdf.line(margin, y, pageWidth - margin, y);
                y += lineSpacing * 2;
                pdf.setFontSize(12).text('FECHAS', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 2;
                pdf.setFontSize(10);
                drawField('FECHA DE INGRESO:', getValue('fecha-ingreso'), y);
                drawField('HORA:', getValue('hora-ingreso'), y, 115, 140);
                y += lineSpacing;
                drawField('FECHA DE EGRESO:', getValue('fecha-egreso'), y);
                drawField('HORA:', getValue('hora-egreso'), y, 115, 140);
                if (user?.especialidad === 'Administrativo' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 2 (Standard) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('INGRESO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.setFontSize(10).setTextColor(0,0,0);
                drawField('PACIENTE:', getValue('paciente-2'), y);
                drawField('HC:', getValue('hc-2'), y, 115, 140);
                y += lineSpacing;
                drawField('SERVICIO:', getValue('servicio'), y);
                drawField('FECHA:', getValue('fecha-2'), y, 115, 140);
                y += lineSpacing;
                drawField('HABITACION:', getValue('habitacion'), y);
                drawField('CAMA:', getValue('cama'), y, 115, 140);
                y += lineSpacing * 2;
                y = drawTextArea('MOTIVO DE INTERNACION:', getTextAreaValue('motivo-internacion'), y, 3);
                y = drawTextArea('DIAGNOSTICO PRESUNTIVO:', getTextAreaValue('diagnostico-presuntivo'), y, 4);
                y = drawTextArea('ESTADO ACTUAL:', getTextAreaValue('estado-actual'), y, 4);
                y = drawTextArea('ANTECEDENTES:', getTextAreaValue('antecedentes'), y, 4);
                y += lineSpacing;
                pdf.setFontSize(14).text('EXAMEN FISICO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing;
                y = drawTextArea('CABEZA Y CUELLO:', getTextAreaValue('cabeza-cuello'), y, 2);
                drawTextArea('APARATO RESPIRATORIO:', getTextAreaValue('aparato-respiratorio'), y, 2);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 3 (Standard) ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                y = drawTextArea('APARATO CARDIOVASCULAR:', getTextAreaValue('aparato-cardiovascular'), y, 4);
                y = drawTextArea('APARATO DIGESTIVO:', getTextAreaValue('aparato-digestivo'), y, 4);
                y = drawTextArea('APARATO LOCOMOTOR:', getTextAreaValue('aparato-locomotor'), y, 4);
                y = drawTextArea('APARATO GENITOUTERINO:', getTextAreaValue('aparato-genitourinario'), y, 4);
                y = drawTextArea('SISTEMA NERVIOSO:', getTextAreaValue('sistema-nervioso'), y, 4);
                y = drawTextArea('OBSERVACIONES:', getTextAreaValue('observaciones'), y, 4);
                y = drawTextArea('ESTUDIOS COMPLEMENTARIOS:', getTextAreaValue('estudios-complementarios'), y, 4);
                drawTextArea('TRATAMENTO:', getTextAreaValue('tratamiento'), y, 4);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 4 (Parte Quirurgico) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('PARTE QUIRURGICO', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 1;
                pdf.setDrawColor(0).setLineWidth(0.2);
                
                pdf.rect(margin, y, pageWidth - margin * 2, 20);
                const contentWidthCA = pageWidth - margin * 2;
                const firstDividerXCA = margin + contentWidthCA *1.5 / 3;
                const secondDividerXCA = firstDividerXCA + (contentWidthCA / 1.7) / 2;
                pdf.line(firstDividerXCA, y, firstDividerXCA, y + 20);
                pdf.line(secondDividerXCA, y, secondDividerXCA, y + 20);
                pdf.line(margin, y + 10, pageWidth - margin, y + 10);
                drawField('PACIENTE:', getValue('paciente-4'), y + 6, margin + 2, margin + 30);
                drawField('GRUPO:', getValue('grupo'), y + 6, firstDividerXCA + 2, firstDividerXCA + 23);
                drawField('RH:', getValue('rh'), y + 6, secondDividerXCA + 2, secondDividerXCA + 17);
                drawField('SERVICIO:', getValue('servicio-4'), y + 16, margin + 2, margin + 30);
                drawField('HAB:', getValue('hab-4'), y + 16, firstDividerXCA + 2, firstDividerXCA + 18);
                drawField('CAMA:', getValue('cama-4'), y + 16, secondDividerXCA + 2, secondDividerXCA + 20);
                y += lineSpacing * 1;
                y += 25;
                drawField('FECHA CIRUGIA:', getValue('fecha-cirugia'), y);
                drawField('HORA:', getValue('hora-cirugia'), y, 115, 140);
                y += lineSpacing;
                drawField('CIRUJANO:', getValue('cirujano'), y);
                y += lineSpacing;
                drawField('AYUDANTE 1:', getValue('ayudante1'), y);
                drawField('AYUDANTE 2:', getValue('ayudante2'), y, 115, 150);
                y += lineSpacing;
                drawField('PEDIATRA:', getValue('pediatra'), y);
                drawField('ANESTESISTA:', getValue('anestesista'), y, 115, 155);
                y += lineSpacing * 1.5;

                y = drawTextArea('DIAGNOSTICO PREOPERATORIO:', getTextAreaValue('diagnostico-preop'), y, 4);
                y = drawTextArea('OPERACIÓN PRACTICADA:', getTextAreaValue('operacion-practicada'), y, 4);
                drawTextArea('DETALLES DE LA TECNICA:', getTextAreaValue('detalles-tecnica'), y, 8);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();
                
                // --- PAGE 5 (Parte Quirurgico Hoja 2) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('PARTE QUIRURGICO HOJA 2', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawField('PACIENTE:', getValue('paciente-5'), y);
                y += lineSpacing * 1.5;
                drawTextArea('', getTextAreaValue('detalles-quirurgico-2'), y, 38);
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 6 (Anesthesia Protocol Cover) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('PROTOCOLO ANESTÉSICO', pageWidth / 2, y, { align: 'center' });
                y += lineSpacing * 4;
                pdf.setFontSize(10).setTextColor(0,0,0);
                const noteText = "El protocolo anestésico completo, firmado por el especialista, se adjunta en las páginas siguientes.";
                const splitNote = pdf.splitTextToSize(noteText, pageWidth - margin * 2);
                pdf.text(splitNote, margin, y);
                if (user?.especialidad === 'Anestesista' || user?.especialidad === 'Administrador') {
                    drawUserSignature();
                }

                // --- PAGE 7 (Evolucion) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('EVOLUCION', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.setDrawColor(0).setLineWidth(0.2);
                pdf.rect(margin, y, pageWidth - margin * 2, 10);
                drawField('PACIENTE:', getValue('paciente-evolucion'), y + 6, margin + 2, margin +29);
                y += 10;
                const evolucionTextCA = getTextAreaValue('evolucion-notas');
                const lineHeightCA = 10;
                const numLinesCA = 22;
                for (let i = 0; i < numLinesCA; i++) {
                    pdf.rect(margin, y, pageWidth - margin * 2, lineHeightCA);
                    if (i < evolucionTextCA.length) {
                        pdf.text(evolucionTextCA[i], margin + 2, y + lineHeightCA / 2 + 1, { baseline: 'middle', maxWidth: pageWidth - (margin * 2) - 4 });
                    }
                    y += lineHeightCA;
                }
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 8 (Prescripciones) ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                pdf.setFontSize(12).text('PRESCRIPCIONES MEDICAS', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawField('PACIENTE:', getValue('paciente-presc'), y);
                y += lineSpacing * 1;
                const prescripcionesTableBody = activeContent.querySelector('.prescripciones-table tbody');
                const prescripcionesRows = prescripcionesTableBody?.querySelectorAll('tr');
                const presCellHeight = 10;
                pdf.rect(margin, y, 30, presCellHeight);
                pdf.text('FECHA', margin + 2, y + presCellHeight/2 + 2);
                pdf.rect(margin + 30, y, pageWidth - margin * 2 - 30, presCellHeight);
                pdf.text('INDICACIONES', margin + 32, y + presCellHeight/2 + 2);
                y += presCellHeight;
                 for(let i = 0; i < 22; i++) {
                    pdf.rect(margin, y, 30, presCellHeight);
                    pdf.rect(margin + 30, y, pageWidth - margin * 2 - 30, presCellHeight);
                    if (prescripcionesRows && i < prescripcionesRows.length) {
                        const cells = prescripcionesRows[i].querySelectorAll('input');
                        pdf.text(cells[0].value, margin + 2, y + presCellHeight/2 + 2);
                        pdf.text(cells[1].value, margin + 32, y + presCellHeight/2 + 2, {maxWidth: pageWidth - margin * 2 - 35});
                    }
                    y += presCellHeight;
                }
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();
                
                // --- PAGE 9 (Prácticas Médicas) ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                pdf.setFontSize(12).text('PRACTICAS MEDICAS', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawField('PACIENTE:', getValue('paciente-practicas'), y);
                y += lineSpacing;
                drawField('MEDICO:', getValue('medico-cabecera'), y);
                y += lineSpacing;
                const practicasHeadersCA = ["Fecha", "Código", "Descripción", "Cant.", "Observación"];
                const practicasColWidthsCA = [30, 20, 50, 15, 70];
                const practicasTableBodyCA = activeContent.querySelector('.practicas-medicas-table tbody');
                pdf.setDrawColor(0).setLineWidth(0.2);
                let currentXCA = margin;
                pdf.rect(margin, y, pageWidth - margin * 2, 8);
                for(let i = 0; i < practicasHeadersCA.length; i++) {
                    pdf.text(practicasHeadersCA[i], currentXCA + 2, y + 4, { baseline: 'middle' });
                    currentXCA += practicasColWidthsCA[i];
                    if (i < practicasHeadersCA.length - 1) pdf.line(currentXCA, y, currentXCA, y + 23 * 8);
                }
                y += 8;
                const practicasRowsCA = practicasTableBodyCA?.querySelectorAll('tr');
                for(let i = 0; i < 22; i++) {
                    pdf.rect(margin, y, pageWidth - margin * 2, 8);
                    if (practicasRowsCA && i < practicasRowsCA.length) {
                        const cells = practicasRowsCA[i].querySelectorAll('input');
                        currentXCA = margin;
                        for(let j = 0; j < cells.length; j++) {
                            pdf.text(cells[j].value, currentXCA + 2, y + 4, { baseline: 'middle', maxWidth: practicasColWidthsCA[j] - 4 });
                            currentXCA += practicasColWidthsCA[j];
                        }
                    }
                    y += 8;
                }
                if (user?.especialidad === 'Médico' || user?.especialidad === 'Administrador') drawUserSignature();

                // --- PAGE 10 (Control de Enfermería) ---
                pdf.addPage();
                drawHeader();
                pdf.setFontSize(10).setTextColor(0,0,0);
                y = 45;
                pdf.setFontSize(12).text('CONTROL DE ENFERMERIA', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                drawField('PACIENTE:', getValue('paciente-enfermeria'), y);
                y += lineSpacing;
                const enfermeriaHeadersCA = ["Fecha", "Hora", "T.A.", "F.C.", "F.R.", "Temp.", "Observaciones"];
                const enfermeriaColWidthsCA = [30, 15, 15, 15, 15, 15, 75];
                const enfermeriaTableBodyCA = activeContent.querySelector('.enfermeria-table tbody');
                currentXCA = margin;
                pdf.rect(margin, y, pageWidth - margin * 2, 8);
                for(let i = 0; i < enfermeriaHeadersCA.length; i++) {
                    pdf.text(enfermeriaHeadersCA[i], currentXCA + 2, y + 4, { baseline: 'middle' });
                    currentXCA += enfermeriaColWidthsCA[i];
                     if (i < enfermeriaHeadersCA.length - 1) pdf.line(currentXCA, y, currentXCA, y + 17 * 12);
                }
                y += 8;
                const enfermeriaRowsCA = enfermeriaTableBodyCA?.querySelectorAll('tr');
                for(let i = 0; i < 16; i++) {
                     pdf.rect(margin, y, pageWidth - margin * 2, 12);
                     if(enfermeriaRowsCA && i < enfermeriaRowsCA.length) {
                        const cells = enfermeriaRowsCA[i].querySelectorAll('input');
                        currentXCA = margin;
                        for(let j = 0; j < cells.length; j++) {
                            pdf.text(cells[j].value, currentXCA + 2, y + 6, { baseline: 'middle', maxWidth: enfermeriaColWidthsCA[j] - 4 });
                            currentXCA += enfermeriaColWidthsCA[j];
                        }
                     }
                     y += 12;
                }
                if (user?.especialidad === 'Enfermero' || user?.especialidad === 'Administrador') drawUserSignature();
                
                // --- PAGE 11 (Report) ---
                pdf.addPage();
                drawHeader();
                y = 45;
                pdf.setFontSize(14).text('REPORT', pageWidth/2, y, { align: 'center'});
                y += lineSpacing * 2;
                pdf.rect(margin, y, pageWidth - margin * 2, 10); // Box for patient
                drawField('PACIENTE:', getValue('paciente-report'), y + 6, margin + 2, margin + 30);
                y += 10;
                pdf.rect(margin, y, pageWidth - margin * 2, 10); // Box for date, sala, cama
                drawField('FECHA:', getValue('fecha-report'), y + 6, margin + 2, margin + 23);
                drawField('SALA:', getValue('sala-report'), y + 6, pageWidth / 2 - 20, pageWidth / 2 - 4);
                drawField('CAMA:', getValue('cama-report'), y + 6, pageWidth / 2 + 50, pageWidth / 2 + 69);
                y += 15;
                const reportContentCA = getTextAreaValue('report-contenido');
                pdf.setLineDashPattern([1, 1], 0);
                let lineY2 = y;
                const reportLineHeight = 8;
                const reportNumLines = 25;
                for(let i = 0; i < reportNumLines; i++) {
                    if (i < reportContentCA.length) {
                        pdf.text(reportContentCA[i], margin, lineY2, { baseline: 'middle', maxWidth: pageWidth - margin * 2 });
                    }
                    pdf.line(margin, lineY2, pageWidth - margin, lineY2);
                    lineY2 += reportLineHeight;
                }
                pdf.setLineDashPattern([], 0);
                if (user?.especialidad === 'Enfermero' || user?.especialidad === 'Administrador') drawUserSignature();

                const patientName = `${getValue('apellido')}, ${getValue('nombres')}`;
                const patientDNI = getValue('dni');
                drawMedicalDischargePage(patientName, patientDNI);

                const finalPdfBytes = pdf.output('arraybuffer');
                const mainPdfDoc = await PDFDocument.load(finalPdfBytes);

                if (scannedFile) {
                    try {
                        const uploadedPdfBytes = await scannedFile.arrayBuffer();
                        const uploadedPdfDoc = await PDFDocument.load(uploadedPdfBytes);
                        
                        const uploadedPagesIndices = uploadedPdfDoc.getPageIndices();
                        const copiedPages = await mainPdfDoc.copyPages(uploadedPdfDoc, uploadedPagesIndices);
                        
                        // Insert the scanned pages after the anesthesia protocol cover page (page 6, index 5)
                        copiedPages.forEach((page, index) => {
                            mainPdfDoc.insertPage(6 + index, page);
                        });

                    } catch (mergeError) {
                        console.error("Error merging PDFs:", mergeError);
                        alert("Error al combinar el PDF escaneado. Se generará el PDF sin el archivo adjunto.");
                    }
                } 

                const finalMergedPdfBytes = await mainPdfDoc.save();
                const blob = new Blob([finalMergedPdfBytes], { type: 'application/pdf' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                const filename = `cirugia-anestesia-${getValue('apellido')}-${getValue('dni')}.pdf`;
                link.download = filename;
                link.click();
                URL.revokeObjectURL(link.href);

                await setDischargeTimestamp();
            }

        } catch (error) {
            console.error("PDF Generation Error:", error);
            alert('Ocurrió un error al generar el PDF. Por favor, revise la consola para más detalles.');
        } finally {
            btn.textContent = originalButtonText;
            btn.disabled = false;
        }
    });

});