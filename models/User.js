const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    email:{
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true
    },
    password: {
        type: String,
        required: true,
    },
    createdAt : {type: Date, deafault: Date.now}
});

userSchema.pre('save', async function (){
    if(!this.isModified('password')) return;
    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS,10) || 12;
    const salt = await bcrypt.genSalt(saltRounds);
    this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = function(candidatePassword){
    return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema)